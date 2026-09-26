import { formatErrorMessage } from "../../infra/errors.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseOperations } from "../../state/openclaw-agent-execution-contract.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  commitSessionEntryReplacementsInDatabase,
  prepareSessionEntryReplacementPublication,
} from "./session-accessor.sqlite-replacement-state.js";

export function commitSessionEntryReplacementsInWorker(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: AgentDatabaseOperations["session.entries.replace"]["input"],
  transcript:
    | {
        initialize: typeof import("./session-accessor.sqlite-transcript-header.js").ensureTranscriptHeader;
        assertIdentity: typeof import("./session-accessor.sqlite-scope.js").assertSqliteTranscriptWriteIdentity;
      }
    | undefined,
  admit: (
    stage: "transaction" | "commit",
    publication?: SessionEntryReplacementPublication,
  ) => void,
) {
  return runOpenClawAgentWriteTransaction(
    (current) => {
      if (current.db !== database.db) {
        throw new Error("Session replacement lost its canonical database owner");
      }
      admit("transaction");
      const result = commitSessionEntryReplacementsInDatabase(current, input, () => {
        const initialization = input.initializeTranscript;
        if (!initialization) {
          return;
        }
        try {
          if (!transcript) {
            throw new Error("Session transcript initialization was not prepared");
          }
          const assertIdentity: typeof import("./session-accessor.sqlite-scope.js").assertSqliteTranscriptWriteIdentity =
            transcript.assertIdentity;
          assertIdentity(initialization);
          transcript.initialize(
            current,
            { agentId: database.agentId, path: database.path, ...initialization },
            initialization.cwd,
          );
        } catch (error) {
          throw Object.assign(new Error(formatErrorMessage(error), { cause: error }), {
            name: "SessionTranscriptInitializationError",
          });
        }
      });
      const publication = prepareSessionEntryReplacementPublication(result);
      deferSqliteWorkerCommitReceipt(current.db, publication);
      admit("commit", publication);
      return result;
    },
    options,
    { operationLabel: "session.entry-replacements" },
  );
}
