import type { Insertable, Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

export type UpdateCheckState = {
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
  lastAvailableVersion?: string;
  lastAvailableTag?: string;
  autoInstallId?: string;
  autoFirstSeenVersion?: string;
  autoFirstSeenTag?: string;
  autoFirstSeenAt?: string;
  autoLastAttemptVersion?: string;
  autoLastAttemptAt?: string;
  autoLastSuccessVersion?: string;
  autoLastSuccessAt?: string;
};

const UPDATE_CHECK_KEY = "state";

type UpdateCheckDatabase = Pick<OpenClawStateKyselyDatabase, "update_check_state">;
type UpdateCheckRow = Selectable<UpdateCheckDatabase["update_check_state"]>;
type UpdateCheckInsert = Insertable<UpdateCheckDatabase["update_check_state"]>;

function sqliteOptionsForEnv(env: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return { env };
}

function coerceUpdateCheckState(value: unknown): UpdateCheckState {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UpdateCheckState)
    : {};
}

function rowToUpdateCheckState(row: UpdateCheckRow): UpdateCheckState {
  const state: UpdateCheckState = {};
  if (row.last_checked_at) {
    state.lastCheckedAt = row.last_checked_at;
  }
  if (row.last_notified_version) {
    state.lastNotifiedVersion = row.last_notified_version;
  }
  if (row.last_notified_tag) {
    state.lastNotifiedTag = row.last_notified_tag;
  }
  if (row.last_available_version) {
    state.lastAvailableVersion = row.last_available_version;
  }
  if (row.last_available_tag) {
    state.lastAvailableTag = row.last_available_tag;
  }
  if (row.auto_install_id) {
    state.autoInstallId = row.auto_install_id;
  }
  if (row.auto_first_seen_version) {
    state.autoFirstSeenVersion = row.auto_first_seen_version;
  }
  if (row.auto_first_seen_tag) {
    state.autoFirstSeenTag = row.auto_first_seen_tag;
  }
  if (row.auto_first_seen_at) {
    state.autoFirstSeenAt = row.auto_first_seen_at;
  }
  if (row.auto_last_attempt_version) {
    state.autoLastAttemptVersion = row.auto_last_attempt_version;
  }
  if (row.auto_last_attempt_at) {
    state.autoLastAttemptAt = row.auto_last_attempt_at;
  }
  if (row.auto_last_success_version) {
    state.autoLastSuccessVersion = row.auto_last_success_version;
  }
  if (row.auto_last_success_at) {
    state.autoLastSuccessAt = row.auto_last_success_at;
  }
  return state;
}

function updateCheckStateToRow(state: UpdateCheckState): UpdateCheckInsert {
  return {
    state_key: UPDATE_CHECK_KEY,
    last_checked_at: state.lastCheckedAt ?? null,
    last_notified_version: state.lastNotifiedVersion ?? null,
    last_notified_tag: state.lastNotifiedTag ?? null,
    last_available_version: state.lastAvailableVersion ?? null,
    last_available_tag: state.lastAvailableTag ?? null,
    auto_install_id: state.autoInstallId ?? null,
    auto_first_seen_version: state.autoFirstSeenVersion ?? null,
    auto_first_seen_tag: state.autoFirstSeenTag ?? null,
    auto_first_seen_at: state.autoFirstSeenAt ?? null,
    auto_last_attempt_version: state.autoLastAttemptVersion ?? null,
    auto_last_attempt_at: state.autoLastAttemptAt ?? null,
    auto_last_success_version: state.autoLastSuccessVersion ?? null,
    auto_last_success_at: state.autoLastSuccessAt ?? null,
    updated_at_ms: Date.now(),
  };
}

export function normalizeUpdateCheckStateSnapshot(value: unknown): UpdateCheckState {
  return coerceUpdateCheckState(value);
}

export function readUpdateCheckStateFromSqlite(
  env: NodeJS.ProcessEnv = process.env,
): UpdateCheckState {
  const database = openOpenClawStateDatabase(sqliteOptionsForEnv(env));
  const db = getNodeSqliteKysely<UpdateCheckDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("update_check_state").selectAll().where("state_key", "=", UPDATE_CHECK_KEY),
  );
  return row ? rowToUpdateCheckState(row) : {};
}

export function writeUpdateCheckStateToSqlite(
  state: UpdateCheckState,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const row = updateCheckStateToRow(coerceUpdateCheckState(state));
  const { state_key: _stateKey, ...updates } = row;
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<UpdateCheckDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("update_check_state")
        .values(row)
        .onConflict((conflict) => conflict.column("state_key").doUpdateSet(updates)),
    );
  }, sqliteOptionsForEnv(env));
}
