import type { SessionCreationSnapshot } from "./session-accessor.sqlite-creation-read.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import type { SessionCreationOperation } from "./session-creation-operation.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

/** Preliminary owner facts avoid workspace/placement effects on a receipt replay. */
export async function readSessionCreationOperationInWorker(
  scope: { agentId: string; storePath: string; sessionKey: string },
  creationOperation: SessionCreationOperation,
): Promise<SessionCreationSnapshot | undefined> {
  // A configured store path may be a logical sessions.json locator. Resolve it
  // through the same owner as creation before passing a physical path to a worker.
  const database = captureLifecycleDatabaseScope(resolveSqliteScope(scope));
  return withSessionHistoryWorkerDatabase(database, async (owner) => {
    const result = await owner.readExactEntries({
      projection: "creation",
      sessionKeys: [scope.sessionKey],
      creationOperation,
      env: database.env,
    });
    return result.creation;
  });
}
