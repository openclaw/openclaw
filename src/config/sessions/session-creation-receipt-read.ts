import {
  captureLifecycleDatabaseScope,
  prepareSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

/** Creation replay uses the existing reader and physical store selection, never host SQL. */
export async function readSessionCreationReceiptInWorker(
  scope: { agentId: string; storePath: string },
  digest: string,
  assertCurrent: () => void,
) {
  const database = captureLifecycleDatabaseScope(
    await prepareSqliteScope({ ...scope, sessionKey: "" }),
  );
  assertCurrent();
  return withSessionHistoryWorkerDatabase(database, async (owner) => {
    const read = await owner.readExactEntries({
      projection: "creation-receipt",
      sessionKeys: [],
      creationDigest: digest,
      env: database.env,
    });
    owner.assertCurrent();
    assertCurrent();
    return read.creationReceipt;
  });
}
