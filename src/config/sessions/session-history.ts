import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type {
  SessionTranscriptInstance,
  SessionTranscriptInstanceListOptions,
} from "./session-accessor.sqlite-contract.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import { listSessionTranscriptInstances } from "./session-history-read.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";

/** Read transcript identities in the existing history worker. */
export async function listSessionTranscriptInstancesInWorker(
  scope: Omit<SessionEntryListScope, "sessionKeys"> = {},
  options: SessionTranscriptInstanceListOptions = {},
): Promise<SessionTranscriptInstance[]> {
  const storePath = resolveSessionStorePathForScope(scope);
  if (
    isIncognitoOpenClawAgentSqlitePath(storePath, { ...scope, agentId: scope.agentId ?? "main" })
  ) {
    return listSessionTranscriptInstances({ ...scope, storePath }, options);
  }
  const { withSessionStoreReaderInWorker } = await import("./session-entry-read-runtime.js");
  return withSessionStoreReaderInWorker(
    { ...scope, storePath },
    async ({ reader, database, logicalAgentId, continuation }) =>
      reader.readTranscriptInstances({
        scope: { ...scope, storePath: database.path, agentId: logicalAgentId },
        options,
        continuation,
      }),
    { backing: true, dataOnly: true },
  );
}

export {
  findSessionTranscriptArchiveEventReadOnly,
  readSessionTaskArchivePageReadOnly,
  verifySessionTranscriptArchivePageBindingReadOnly,
} from "./session-accessor.sqlite-history.js";
