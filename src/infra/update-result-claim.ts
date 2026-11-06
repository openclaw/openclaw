import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state-row.js";
import { writeConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { EngineConnection } from "./sql-connection.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { buildUpdateResultPayload, type UpdateResultPayload } from "./update-result-payload.js";
import type { UpdateRunRecord } from "./update-run-record.js";

// Shared-state worker storage: never import host configuration here. The host
// decides update-request policy at admission and again before network dispatch.
// Internal local bookkeeping key, not a user configuration or consent setting.
const STATE_KEY = "telemetry.updateResults";
const ATTEMPT_INTERVAL_MS = 60 * 60 * 1000;
const RETAINED_RUN_IDS = 16;
// Abandonment can subsequently be repaired; an owner refusal never attempted an update.
const UNREPORTED_REASONS = new Set(["abandoned", "superseded", "owner_required"]);

// One bounded singleton, not an outbox. All identity and times remain local.
type ClaimState = { eligible: string[]; attempted: string[]; lastAttemptAt?: number };

function isRunIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readClaimState(db: EngineConnection): ClaimState | undefined {
  const row = readConfigMachineStateRowInDatabase(db, STATE_KEY);
  const value: unknown = row ? JSON.parse(row.value_json) : undefined;
  if (!isRecord(value) || !isRunIdList(value.eligible) || !isRunIdList(value.attempted)) {
    return undefined;
  }
  return {
    eligible: value.eligible,
    attempted: value.attempted,
    ...(typeof value.lastAttemptAt === "number" ? { lastAttemptAt: value.lastAttemptAt } : {}),
  };
}

/**
 * Confine bookkeeping to a savepoint inside the caller's update transaction. A failed
 * statement otherwise aborts the whole PostgreSQL transaction, so the update write
 * would roll back; here only the bookkeeping is lost.
 */
function runBookkeeping<T>(db: EngineConnection, operation: () => T): T | undefined {
  try {
    return runSqliteImmediateTransactionSync(db, operation);
  } catch {
    return undefined;
  }
}

/** Admission is recorded only for a newly created run, never by scanning update history. */
export function admitUpdateResultInTransaction(db: EngineConnection, runId: string): void {
  runBookkeeping(db, () => {
    // Older restored state databases can predate machine-state storage.
    if (!tableExists(db, "config_machine_state")) {
      return;
    }
    const state = readClaimState(db) ?? { eligible: [], attempted: [] };
    writeConfigMachineStateInDatabase(db, STATE_KEY, {
      ...state,
      eligible: [...state.eligible.filter((id) => id !== runId), runId].slice(-RETAINED_RUN_IDS),
    });
  });
}

/** Drop eligibility and claim at most one hourly attempt with the terminal write, before network. */
export function claimUpdateResultInTransaction(
  db: EngineConnection,
  run: UpdateRunRecord,
): UpdateResultPayload | undefined {
  return runBookkeeping(db, () => {
    if (run.status === "running" || !tableExists(db, "config_machine_state")) {
      return undefined;
    }
    const state = readClaimState(db);
    if (!state?.eligible.includes(run.runId)) {
      return undefined;
    }
    const now = Date.now();
    const eligible = state.eligible.filter((id) => id !== run.runId);
    const payload =
      state.attempted.includes(run.runId) ||
      // A clock moved backwards also suppresses the attempt.
      (state.lastAttemptAt !== undefined && now - state.lastAttemptAt < ATTEMPT_INTERVAL_MS) ||
      (run.reason !== null && UNREPORTED_REASONS.has(run.reason))
        ? undefined
        : buildUpdateResultPayload(run);
    writeConfigMachineStateInDatabase(
      db,
      STATE_KEY,
      payload
        ? {
            eligible,
            attempted: [...state.attempted, run.runId].slice(-RETAINED_RUN_IDS),
            lastAttemptAt: now,
          }
        : { ...state, eligible },
    );
    return payload;
  });
}
