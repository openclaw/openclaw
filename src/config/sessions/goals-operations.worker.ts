import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import { ensureSessionGoalOperationsSchema } from "../../state/openclaw-agent-goal-operations-schema.js";
import {
  mutateSessionGoalInDatabase,
  type SessionGoalManagementInput,
} from "./goals-operations.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import { readRefusedSessionSource } from "./session-source-predicate.worker.js";

export type SessionGoalManagementResult = Omit<
  ReturnType<typeof mutateSessionGoalInDatabase>,
  "previous"
>;
export type SessionGoalManagementCandidate = {
  kind: "session-goal-management";
  publication?: SessionEntryReplacementPublication;
} & (
  | { result: SessionGoalManagementResult; refusedSource?: never }
  | { result?: never; refusedSource: NonNullable<ReturnType<typeof readRefusedSessionSource>> }
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
  bound: {
    database: DatabaseSync;
    databasePath: string;
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction): void;
  },
): SqliteWorkerBackend<SessionGoalManagementOperations> {
  const options = {
    agentId: input.agentId,
    path: bound.databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database || database.db !== bound.database) {
    throw new Error("Goal management lost its canonical database owner");
  }
  ensureSessionGoalOperationsSchema(database.db);
  const admit = (stage: "transaction" | "commit", publication?: unknown) => {
    bound.admit(stage, (request, dispatch) => {
      if (!isRecord(request.facts)) {
        throw new Error("Goal admission omitted its database identity");
      }
      dispatch({ ...request, facts: { ...request.facts, publication } });
    });
  };
  return {
    execute({ input: request }) {
      return runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== bound.database) {
            throw new Error("Goal transaction lost its canonical database owner");
          }
          admit("transaction");
          const assertSources = () => {
            const refusedSource = readRefusedSessionSource(current, request.sources);
            if (refusedSource) {
              const refused: SessionGoalManagementCandidate = {
                kind: "session-goal-management",
                refusedSource,
              };
              transferSessionEntryWorkerCandidate(current, admit, refused);
              throw new Error("Goal source refusal was not rejected");
            }
          };
          assertSources();
          const { previous, ...result } = mutateSessionGoalInDatabase(current, request);
          assertSources();
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
        },
        options,
        { operationLabel: "session.goal.mutate" },
      );
    },
    assertSettled() {
      assertTransactionUsable(database.db);
      if (database.db.isTransaction) {
        throw new Error("Goal transaction did not settle");
      }
    },
    close() {},
  };
}
