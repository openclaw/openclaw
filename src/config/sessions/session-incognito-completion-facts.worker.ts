import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { readHarnessCompletionSourceInDatabase } from "./session-harness-completion-source.kernel.js";
import type { IncognitoSessionFacts } from "./session-incognito-contract.js";
import type { IncognitoHistoryOperations } from "./session-incognito-history-contract.js";
import {
  runWithSessionTranscriptReadFence,
  resolveSqliteSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";

/** Read completion validity from the worker's current rows and active transcript branch. */
export function readIncognitoCompletionFacts(
  database: OpenClawAgentDatabase,
  completionSources: Iterable<
    IncognitoHistoryOperations["session.history.completion-source.open"]["input"]
  >,
  sessionKey: string,
): IncognitoSessionFacts["completionSources"] {
  return [...completionSources]
    .filter((source) => source.sessionKey === sessionKey)
    .map((source) => {
      let valid = false;
      try {
        valid = runWithSessionTranscriptReadFence(source.admission, () => {
          // Even an original admitted delivery must retain its exact branch/reset fence.
          if (source.admission) {
            resolveSqliteSessionTranscriptReadFence({
              database,
              agentId: database.agentId,
              sessionKey,
              sessionId: source.sessionId,
            });
          }
          if ("entryId" in source) {
            const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
            return (
              entry?.sessionId === source.sessionId &&
              entry.lifecycleRevision === source.lifecycleRevision &&
              Boolean(
                readActiveTranscriptEntryAnchorInTransaction({
                  database,
                  resolved: {
                    agentId: database.agentId,
                    path: database.path,
                    sessionKey,
                    sessionId: source.sessionId,
                  },
                  entryId: source.entryId,
                }),
              )
            );
          }
          const snapshot = readHarnessCompletionSourceInDatabase(database, source.claim);
          return (
            snapshot.entry?.sessionId === source.sessionId &&
            snapshot.entry?.lifecycleRevision === source.lifecycleRevision &&
            snapshot.validInput
          );
        });
      } catch (error) {
        if (!(error instanceof SessionTranscriptReadFenceError)) {
          throw error;
        }
      }
      return { sourceId: source.sourceId, valid };
    });
}
