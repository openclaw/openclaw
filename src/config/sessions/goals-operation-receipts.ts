// Native receipt reads and writes must not acquire host session actors.
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { validateSessionsGoalMutationResult as validateReceipt } from "../../../packages/gateway-protocol/src/session-result-validators.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { getAdmittedSqlSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { SESSION_GOAL_OPERATIONS_TABLE } from "../../state/openclaw-agent-goal-operations-schema.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  assertSessionGoalOperationTime,
  createSessionGoalOperationResult,
  MAX_SESSION_RECEIPTS,
  OPERATION_VALIDITY_MS,
  operationFingerprint,
} from "./goals-operation-policy.js";
import {
  SessionGoalOperationError,
  type SessionGoalOperation,
  type SessionGoalOperationLookup,
  type SessionGoalOperationResult,
} from "./goals-operations.types.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionGoal } from "./types.js";

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
