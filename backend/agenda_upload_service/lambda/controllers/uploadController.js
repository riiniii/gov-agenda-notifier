/* eslint-disable no-restricted-syntax */
const csvtojson = require('csvtojson');
const getDBClient = require('../db/dbClient');

module.exports = (logger) => {
  const module = {};

  const dbLifeCycleWrapper = async (controllerFunc, req, res) => {
    let dbClient;
    try {
      dbClient = await getDBClient(logger);
      await dbClient.init();
      return await controllerFunc(dbClient, req, res);
    } catch (err) {
      logger.error(`Controller error: ${err}`);
      throw err;
    } finally {
      try {
        logger.info('Ending DB connection');
        await dbClient.end();
      } catch (err) {
        logger.error(`Error ending DB connection: ${err.stack}`);
      }
    }
  };

  const ingestData = async (dbClient, csvData) => {
    const jsonValue = await csvtojson().fromString(csvData);

    const agendaItems = new Map();
    // The reason why we store the CSV data into nested maps is
    // to facilitate the handling of unordered CSV data
    jsonValue.forEach((row) => {
      const title = row.Title;
      const agendaNumber = row['Agenda #'];

      // We split the Agenda Number string to facilitate the storage of sub items
      // Agenda Numbers are formatted in the following way:
      // "1.", "1.1", "1.2", "2.", "2.1", etc...
      const splitAgendaNumber = agendaNumber.split('.');
      if (splitAgendaNumber[1] === '') {
        // This row is a root item]
        agendaItems.set(agendaNumber, [title, new Map()]);
      } else {
        // This is a sub item
        // TODO: not currently handling unordered data - currently we're assuming
        // that if there's a sub number, the root has already been created
        const rootItemNumber = splitAgendaNumber[0];
        const subItemNumber = splitAgendaNumber[1];
        const subItemMap = agendaItems.get(`${rootItemNumber}.`)[1];
        subItemMap.set(subItemNumber, title);
      }
    });

    let meetingId;
    try {
      const res = await dbClient.createMeeting('test', 1, '', 'PENDING');
      meetingId = res.rows[0].id;
    } catch (err) {
      logger.error(err);
    }

    // Here we loop through our new agenda data structure and update our DB.
    // Despite its nested loops, this portion actually runs in O(N) time complexity,
    // ignoring DB interaction, where N is equal to the number of rows in the input
    // CSV file. Fun fact
    let orderNumber = 1;
    for (const rootItemNumber of agendaItems.keys()) {
      const rootItem = agendaItems.get(rootItemNumber);
      const title = rootItem[0];

      // This is a root item
      let amendedTitle = `${rootItemNumber} ${title}`;
      // eslint-disable-next-line no-await-in-loop
      const res = await dbClient.createMeetingItem(
        meetingId, null, orderNumber, null, null,
        'PENDING', '[content, categories]', 'description', amendedTitle,
      );
      const rootMeetingItemId = res.rows[0].id;
      orderNumber += 1;

      const subItems = rootItem[1];
      for (const subItemNumber of subItems.keys()) {
        const subTitle = subItems.get(subItemNumber);
        logger.debug(`Creating nested meeting item: ${subTitle}`);

        // This is a nested item
        amendedTitle = `${rootItemNumber}${subItemNumber} ${title}`;
        // eslint-disable-next-line no-await-in-loop
        const res = await dbClient.createMeetingItem(
          meetingId, rootMeetingItemId, orderNumber, null, null,
          'PENDING', '[content, categories]', 'description', amendedTitle,
        );
        orderNumber += 1;
      }
    }

    return 'CSV Uploaded!';
  };

  const csvUpload = async (dbClient, req, res) => {
    logger.info('CSV Upload Controller');
    // This is the expected value of the name attribute in the upload request
    const expectedNameAttribute = 'csvfile';

    if (expectedNameAttribute in req.files) {
      const csvData = req.files[expectedNameAttribute].data.toString('utf8');
      const jsonValue = await ingestData(dbClient, csvData);
      res.status(201).json({ jsonValue });
    } else {
      const message = '400 Bad Request: unrecongized name attribute';
      logger.info(message);
      res.status(400).json({ message });
    }
  };

  module.csvUpload = async (req, res) => dbLifeCycleWrapper(csvUpload, req, res);

  return module;
};
