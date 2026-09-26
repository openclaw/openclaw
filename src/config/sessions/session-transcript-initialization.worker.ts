import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseOperations } from "../../state/openclaw-agent-execution-contract.js";
import type { SessionTranscriptInitializationPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";

export function initializeSessionTranscriptTransaction(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: AgentDatabaseOperations["session.transcript.initialize"]["input"],
  admit: (
    stage: "transaction" | "commit",
    publication?: SessionTranscriptInitializationPublication,
  ) => void,
) {
  return runOpenClawAgentWriteTransaction(
    (current) => {
      if (current.db !== database.db) {
        throw new Error("Session transcript lost its canonical database owner");
      }
      admit("transaction");
      const publication: SessionTranscriptInitializationPublication = {
        kind: "session-transcript-initialized",
        sessionKey: input.sessionKey,
      };
      ensureTranscriptHeader(
        current,
        { agentId: database.agentId, path: database.path, ...input },
        input.cwd,
        {
          onPlaceholderInserted: ({ sessionId }) => {
            publication.placeholder = { sessionId };
          },
        },
      );
      deferSqliteWorkerCommitReceipt(current.db, publication);
      admit("commit", publication);
      return publication;
    },
    options,
    { operationLabel: "session.entry.create-with-transcript" },
  );
}
