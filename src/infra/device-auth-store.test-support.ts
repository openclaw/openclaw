import { holdStateDatabaseWriteTransaction } from "../test-utils/state-database-contention.js";

/** Hold a synthetic native writer while the host proves its asynchronous admission. */
export async function holdDeviceAuthWriterForTest(databasePath: string) {
  const holder = holdStateDatabaseWriteTransaction(databasePath, 10_000);
  await holder.ready;
  return async () => {
    holder.release();
    await holder.joined;
  };
}
