import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { lazyCompile } from "../../../packages/gateway-protocol/src/protocol-validator.js";
import { SessionsGoalMutationResultSchema } from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import {
  ensureSessionGoalOperationsSchema,
  SESSION_GOAL_OPERATIONS_TABLE,
} from "../../state/openclaw-agent-goal-operations-schema.js";
import {
  applySessionGoalOperation,
  assertSessionGoalOperationTime,
  createSessionGoalOperationResult,
  MAX_SESSION_RECEIPTS,
  OPERATION_VALIDITY_MS,
  operationFingerprint,
} from "./goals-operation-policy.js";
import { SessionGoalOperationError } from "./goals-operations.types.js";
import type {
  SessionGoalManagementInput,
  SessionGoalManagementCommit,
  SessionGoalOperation,
  SessionGoalOperationLookup,
  SessionGoalOperationResult,
  SessionTranscriptTurnMutationResult,
} from "./goals-operations.types.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
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
import { mergeSessionEntry, type SessionEntry, type SessionGoal } from "./types.js";

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
  return runSqliteDeferredTransactionSync(db, () => {
    const schema = getAdmittedSqliteSchemaFacts(db);
    if (!schema) {
      throw new Error("Goal receipt reads require admitted schema facts");
    }
    if (!schema.tables.has(SESSION_GOAL_OPERATIONS_TABLE)) {
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
  db: DatabaseSync,
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
  db: DatabaseSync,
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
  const count =
    executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom(SESSION_GOAL_OPERATIONS_TABLE)
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("session_key", "=", sessionKey),
    )?.count ?? 0;
  if (count >= MAX_SESSION_RECEIPTS) {
    // Evicting a still-valid receipt would turn a retry into a second operation.
    throw new SessionGoalOperationError(
      "capacity",
      "Too many recent Goal operations; wait for older requests to expire before trying again.",
    );
  }
  const result = createSessionGoalOperationResult(sessionId, operation, goal, runId);
  executeSqliteQuerySync(
    db,
    kysely.insertInto(SESSION_GOAL_OPERATIONS_TABLE).values({
      session_key: sessionKey,
      operation_id: operation.operationId,
      session_id: sessionId,
      request_fingerprint: operationFingerprint(operation),
      result_json: JSON.stringify(result),
      expires_at: operation.issuedAtMs + OPERATION_VALIDITY_MS,
    }),
  );
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
  const input = structuredClone({
    sessionKey: resolved.sessionKey,
    expectedSessionId: options.expectedSessionId,
    operation: options.operation,
  });
  return runExclusiveSqliteSessionWrite(
    resolved,
    async () => {
      const native = async (assertCaptured?: () => void) => {
        ensureSessionGoalOperationsSchema(openOpenClawAgentDatabase(databaseOptions).db);
        const { previous: _previous, ...result } = runOpenClawAgentWriteTransaction(
          (database) => {
            assertCaptured?.();
            options.assertCurrent?.();
            return mutateSessionGoalInDatabase(database, input);
          },
          databaseOptions,
          { operationLabel: "session.goal.mutate" },
        );
        return result;
      };
      // The outer FIFO captures the physical store before waiting and retains preparation order.
      // Maintenance and opaque Gateway/SDK guards keep their native atomicity.
      if (
        !isMainThread ||
        !supportsOpenClawAgentDatabaseExecution(databaseOptions) ||
        (options.assertCurrent && !options.assertCurrent.prepareSessionSource)
      ) {
        return native();
      }
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
        native,
      );
    },
    "session.goal.mutate",
  );
}

/** Receipt replay and the reducer share the current row and the caller's synchronous transaction. */
export function mutateSessionGoalInDatabase(
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
