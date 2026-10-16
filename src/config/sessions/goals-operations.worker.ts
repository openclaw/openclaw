import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureSessionGoalOperationsSchema } from "../../state/openclaw-agent-goal-operations-schema.js";
import { applySessionGoalOperation } from "./goals-operation-policy.js";
import {
  readSessionGoalOperationReceipt,
  writeSessionGoalOperationReceipt,
} from "./goals-operations.js";
import {
  SessionGoalOperationError,
  type SessionGoalManagementCommit,
  type SessionGoalManagementInput,
} from "./goals-operations.types.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import {
  bindSessionWorkerBackend,
  transferSessionEntryWorkerCandidate,
  type SessionWorkerDatabaseBinding,
} from "./session-entry-patch.worker.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import { mergeSessionEntry } from "./types.js";

export type SessionGoalManagementResult = Omit<
  ReturnType<typeof mutateSessionGoalInDatabase>,
  "previous"
>;
export type SessionGoalManagementCandidate = {
  kind: "session-goal-management";
  publication?: SessionEntryReplacementPublication;
} & (
  | { result: SessionGoalManagementResult; refusedSource?: never }
  | {
      result?: never;
      refusedSource: NonNullable<ReturnType<typeof readSessionSourceValidation>["refusedSource"]>;
    }
);

export type SessionGoalManagementOperations = {
  "session.goal.mutate": {
    input: SessionGoalManagementInput & { sources: SessionSourcePredicate[] };
    output: ReturnType<typeof transferSessionEntryWorkerCandidate>;
  };
};

/** Lend the existing executor connection; keep this private command outside the released SDK union. */
export function bindSqliteWorkerBackend(
  input: { agentId: string },
  bound: SessionWorkerDatabaseBinding,
): SqliteWorkerBackend<SessionGoalManagementOperations> {
  return bindSessionWorkerBackend<SessionGoalManagementOperations>(
    input,
    bound,
    "Goal",
    ({ admit, writeTransaction }, database) => {
      ensureSessionGoalOperationsSchema(database.db);
      return ({ input: request }) => {
        return writeTransaction("session.goal.mutate", "Goal transaction", (current) => {
          const assertSources = () => {
            const validation = readSessionSourceValidation(current, request.sources);
            const { refusedSource } = validation;
            if (refusedSource) {
              const refused: SessionGoalManagementCandidate = {
                kind: "session-goal-management",
                refusedSource,
              };
              transferSessionEntryWorkerCandidate(current, admit, refused);
              throw new Error("Goal source refusal was not rejected");
            }
            if (validation.conversationMatches.length) {
              admit("transaction", {
                kind: "session-entry-patch-validated",
                sourceValidation: validation,
              });
            }
          };
          assertSources();
          const { previous, ...result } = mutateSessionGoalInDatabase(current, request);
          const candidate: SessionGoalManagementCandidate = {
            kind: "session-goal-management",
            result,
            publication:
              previous && result.sessionEntry
                ? prepareSessionEntryReplacementPublication(
                    {
                      previous: new Map([[request.sessionKey, previous]]),
                      current: new Map([[request.sessionKey, result.sessionEntry]]),
                      pendingArchiveRecovery: false,
                      membershipInvalidatedKeys: [],
                      maintenancePlans: [],
                    },
                    current,
                  )
                : undefined,
          };
          return transferSessionEntryWorkerCandidate(current, admit, candidate);
        });
      };
    },
    "Goal management",
  );
}

/** Receipt replay and the reducer share the current row and the caller's synchronous transaction. */
function mutateSessionGoalInDatabase(
  database: OpenClawAgentDatabase,
  input: SessionGoalManagementInput,
): SessionGoalManagementCommit {
  const fresh = readSessionEntryRow(database, input.sessionKey);
  const replay = readSessionGoalOperationReceipt(
    database.db,
    input.sessionKey,
    input.expectedSessionId,
    input.operation,
  );
  if (replay && fresh?.entry.sessionId === input.expectedSessionId) {
    return { result: replay, replayed: true };
  }
  if (!fresh || fresh.entry.sessionId !== input.expectedSessionId) {
    throw new SessionGoalOperationError(
      "session-rebound",
      "Session changed; refresh before changing its Goal.",
    );
  }
  const goal = applySessionGoalOperation(fresh.entry, input.operation, Date.now());
  const sessionEntry = writeSessionEntry(
    database,
    input.sessionKey,
    mergeSessionEntry(fresh.entry, { goal }),
    {
      canonicalPreviousEntry: fresh.entry,
    },
  );
  const result = writeSessionGoalOperationReceipt(
    database.db,
    input.sessionKey,
    input.expectedSessionId,
    input.operation,
    goal,
  );
  return { result, replayed: false, sessionEntry, previous: fresh.entry };
}
