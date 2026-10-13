import { isDeepStrictEqual } from "node:util";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readTranscriptSnapshot } from "./session-accessor.sqlite-read.js";
import { readTranscriptMirrorFacts } from "./session-accessor.sqlite-transcript-mirror.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { assertLockedTranscriptWriteAllowed } from "./session-accessor.sqlite-transcript-write-guard.js";
import type { IncognitoTranscriptLockOperations } from "./session-incognito-transcript-lock-contract.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionSourceValidation } from "./session-source-authority.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import type { RefusedTranscriptOwnerSource } from "./session-transcript-mutation.types.js";

export function executeIncognitoTranscriptLock(
  database: OpenClawAgentDatabase,
  command: SqliteWorkerCommand<IncognitoTranscriptLockOperations>,
  incarnation: string,
  acceptValidation: (validation: SessionSourceValidation) => void,
) {
  const input = command.input;
  const scope = {
    agentId: database.agentId,
    path: database.path,
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
  };
  const version = () => ({
    ...readTranscriptContextVersionInTransaction(database, input.sessionId),
  });
  const assertOwner = ():
    | RefusedTranscriptOwnerSource
    | {
        sourceValidation: SessionSourceValidation;
      } => {
    const validation = readSessionSourceValidation(database, input.ownerSources, incarnation);
    if (command.type === "session.lock.replace") {
      acceptValidation(validation);
    }
    const refusedOwnerSource = validation.refusedSource;
    if (refusedOwnerSource) {
      return { refusedOwnerSource };
    }
    assertLockedTranscriptWriteAllowed(database, scope, { ...scope, ...input.fence });
    return { sourceValidation: validation };
  };
  if (command.type === "session.lock.replace") {
    const owner = assertOwner();
    if ("refusedOwnerSource" in owner) {
      return owner;
    }
    if (!isDeepStrictEqual(version(), command.input.expected)) {
      throw new SqliteTranscriptMutationConflictError(input.sessionId);
    }
    replaceSqliteTranscriptEventsInTransaction(database, scope, command.input.events);
    return version();
  }
  return runSqliteDeferredTransactionSync(database.db, () => {
    const owner = assertOwner();
    if ("refusedOwnerSource" in owner) {
      return owner;
    }
    return command.type === "session.lock.events"
      ? {
          version: version(),
          events: readTranscriptSnapshot(database, input.sessionId).events,
          sourceValidation: owner.sourceValidation,
        }
      : {
          version: version(),
          facts: readTranscriptMirrorFacts(database, scope, command.input),
          sourceValidation: owner.sourceValidation,
        };
  });
}
