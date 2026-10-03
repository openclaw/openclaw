import { fileLogTransport } from "./logger-file-transport.js";

export const testApi = {
  drainFileLogQueueSyncForTests: fileLogTransport.drainSync,
  flushFileLogQueueForTests: fileLogTransport.flush,
  resetFileLogTransportForTests: fileLogTransport.resetForTests,
  setFileLogQueueMaxRecordsForTests: fileLogTransport.setMaxQueuedRecordsForTests,
};
