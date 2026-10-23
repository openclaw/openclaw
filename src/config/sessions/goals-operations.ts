import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { lazyCompile } from "../../../packages/gateway-protocol/src/protocol-validator.js";
import { SessionsGoalMutationResultSchema } from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { getAdmittedSqlSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { SESSION_GOAL_OPERATIONS_TABLE } from "../../state/openclaw-agent-goal-operations-schema.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  assertSessionGoalOperationTime,
  createSessionGoalOperationResult,
  MAX_SESSION_RECEIPTS,
  OPERATION_VALIDITY_MS,
  operationFingerprint,
} from "./goals-operation-policy.js";
import { SessionGoalOperationError } from "./goals-operations.types.js";
import type {
  SessionGoalManagementInput,
  SessionGoalOperation,
  SessionGoalOperationLookup,
  SessionGoalOperationResult,
  SessionTranscriptTurnMutationResult,
} from "./goals-operations.types.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  captureLifecycleDatabaseScope,
  getSessionKysely,
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import type { SessionEntry, SessionGoal } from "./types.js";

export type { SessionGoalOperation, SessionGoalOperationResult } from "./goals-operations.types.js";

const validateReceipt = lazyCompile<SessionGoalOperationResult>(SessionsGoalMutationResultSchema);

export { SessionGoalOperationError } from "./goals-operations.types.js";

/** Read the receipt and its session generation from one admitted snapshot. */
export function readSessionGoalOperationInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  options: SessionGoalOperationLookup,
): SessionGoalOperationResult | undefined {
  assertSessionGoalOperationTime(options.operation, Date.now());
  const { db } = database;
  return runSqliteReadSnapshotSync(db, () => {
    if (!getAdmittedSqlSchemaFacts(db)) {
      throw new Error("Goal receipt reads require admitted schema facts");
    }
    if (!tableExists(db, SESSION_GOAL_OPERATIONS_TABLE)) {
      return undefined;
    }
    const receipt = readSessionGoalOperationReceipt(
      db,
      options.sessionKey,
      options.expectedSessionId,
      options.operation,
    );
    if (
      receipt &&
      readSessionEntryRow(database, options.sessionKey)?.entry.sessionId !==
        options.expectedSessionId
    ) {
      throw new SessionGoalOperationError(
        "session-rebound",
        "Session changed after this Goal operation; refresh before trying again.",
      );
    }
    return receipt;
  });
}

/** The caller has installed the schema before BEGIN; this read participates in its transaction. */
export function readSessionGoalOperationReceipt(
  db: EngineConnection,
  sessionKey: string,
  sessionId: string,
  operation: SessionGoalOperation,
): SessionGoalOperationResult | undefined {
  assertSessionGoalOperationTime(operation, Date.now());
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSessionKysely(db)
      .selectFrom(SESSION_GOAL_OPERATIONS_TABLE)
      .selectAll()
      .where("session_key", "=", sessionKey)
      .where("operation_id", "=", operation.operationId),
  );
  if (!row) {
    return undefined;
  }
  if (row.request_fingerprint !== operationFingerprint(operation)) {
    throw new SessionGoalOperationError(
      "operation-conflict",
      "Goal operation ID was already used for a different request.",
    );
  }
  if (row.session_id !== sessionId) {
    throw new SessionGoalOperationError(
      "session-rebound",
      "Session changed after this Goal operation; refresh before trying again.",
    );
  }
  const result = safeParseJson(row.result_json);
  if (
    !validateReceipt(result) ||
    result.operationId !== operation.operationId ||
    result.action !== operation.action ||
    result.sessionId !== sessionId ||
    ("goalId" in operation && result.goalId !== operation.goalId) ||
    (result.goal !== undefined && result.goal.id !== result.goalId)
  ) {
    throw new SessionGoalOperationError(
      "receipt-invalid",
      "Stored Goal operation receipt is invalid; inspect the session before retrying.",
    );
  }
  return result;
}

/** Called only after every Goal/turn/lifecycle write succeeds, in that same transaction. */
export function writeSessionGoalOperationReceipt(
  db: EngineConnection,
  sessionKey: string,
  sessionId: string,
  operation: SessionGoalOperation,
  goal: SessionGoal | undefined,
  runId?: string,
): SessionGoalOperationResult {
  const now = Date.now();
  assertSessionGoalOperationTime(operation, now);
  const kysely = getSessionKysely(db);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom(SESSION_GOAL_OPERATIONS_TABLE).where("expires_at", "<=", now),
  );
  const result = createSessionGoalOperationResult(sessionId, operation, goal, runId);
  const inserted = executeSqliteQuerySync(
    db,
    kysely
      .insertInto(SESSION_GOAL_OPERATIONS_TABLE)
      .columns([
        "session_key",
        "operation_id",
        "session_id",
        "request_fingerprint",
        "result_json",
        "expires_at",
      ])
      .expression(
        kysely
          .selectNoFrom((eb) => [
            eb.val(sessionKey).as("session_key"),
            eb.val(operation.operationId).as("operation_id"),
            eb.val(sessionId).as("session_id"),
            eb.val(operationFingerprint(operation)).as("request_fingerprint"),
            eb.val(JSON.stringify(result)).as("result_json"),
            eb.val(operation.issuedAtMs + OPERATION_VALIDITY_MS).as("expires_at"),
          ])
          .where(
            kysely
              .selectFrom(SESSION_GOAL_OPERATIONS_TABLE)
              .select(({ fn }) => fn.countAll<number>().as("count"))
              .where("session_key", "=", sessionKey),
            "<",
            MAX_SESSION_RECEIPTS,
          ),
      ),
  );
  if (inserted.numAffectedRows === 0n) {
    // Evicting a still-valid receipt would turn a retry into a second operation.
    throw new SessionGoalOperationError(
      "capacity",
      "Too many recent Goal operations; wait for older requests to expire before trying again.",
    );
  }
  return result;
}

/** Management-only Goal actions do not enter chat or fabricate user turns. */
export async function mutateSessionGoal(
  options: SessionAccessScope &
    SessionGoalManagementInput & {
      /** Revalidate the Gateway-owned authorization after waiting for the writer queue. */
      assertCurrent?: SessionSourceAssertion;
    },
): Promise<SessionTranscriptTurnMutationResult & { sessionEntry?: SessionEntry }> {
  const assertCurrent = () => options.assertCurrent?.();
  const authority = { assertCurrent, authorize: assertCurrent };
  const memory = captureSessionActorStorageOwner(options, authority);
  if (memory) {
    const result = await withSessionActorStorage(
      options,
      { lifetime: { assertCurrent, assertReadable: assertCurrent }, authority: memory.authority },
      async (binding) => {
        let authorityFailure: unknown;
        const outcome = await binding.actor.storage!.mutate(
          {
            type: "session.goal.mutate",
            input: {
              sessionKey: binding.actor.target.sessionKey,
              expectedSessionId: options.expectedSessionId,
              operation: options.operation,
            },
          },
          {
            ...binding.authority,
            assertCurrent() {
              try {
                binding.authority.assertCurrent();
              } catch (error) {
                authorityFailure = error;
                throw error;
              }
            },
            authorize(stage, facts, publication) {
              try {
                binding.authority.authorize(stage, facts, publication);
              } catch (error) {
                authorityFailure = error;
                throw error;
              }
            },
          },
        );
        if (outcome.kind === "rolled-back" && authorityFailure instanceof Error) {
          throw authorityFailure;
        }
        const committed = readSessionActorStorageResult(outcome);
        const { previous: _previous, ...receipt } = committed;
        return receipt;
      },
    );
    if (!result) {
      throw new SessionGoalOperationError(
        "session-rebound",
        "Session changed; refresh before changing its Goal.",
      );
    }
    return result;
  }
  const resolved = captureLifecycleDatabaseScope(resolveSqliteScope(options));
  const databaseOptions = toDatabaseOptions(resolved);
  const input = {
    sessionKey: resolved.sessionKey,
    expectedSessionId: options.expectedSessionId,
    operation: options.operation,
  };
  return runExclusiveSqliteSessionWrite(
    resolved,
    async () => {
      // The existing writer owns durable Goal changes and publishes them before FIFO release.
      const execution = captureOpenClawAgentDatabaseExecution(databaseOptions);
      const client = await import("./goals-management.js").catch(async (error: unknown) => {
        await execution.release();
        throw error;
      });
      return client.mutateSessionGoalInWorker(
        { ...databaseOptions, path: resolved.path },
        resolved.agentId,
        execution,
        input,
        composeSessionSourceAssertion([options.assertCurrent], (assertSources) => {
          assertSources();
          assertSessionGoalOperationTime(input.operation, Date.now());
        }),
      );
    },
    "session.goal.mutate",
  );
}
