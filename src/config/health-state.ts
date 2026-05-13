import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { isRecord } from "../utils.js";

export type ConfigHealthFingerprint = {
  hash: string;
  bytes: number;
  mtimeMs: number | null;
  ctimeMs: number | null;
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
  hasMeta: boolean;
  gatewayMode: string | null;
  observedAt: string;
};

export type ConfigHealthEntry = {
  lastKnownGood?: ConfigHealthFingerprint;
  lastPromotedGood?: ConfigHealthFingerprint;
  lastObservedSuspiciousSignature?: string | null;
};

export type ConfigHealthState = {
  entries?: Record<string, ConfigHealthEntry>;
};

type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;
type ConfigHealthRow = Selectable<ConfigHealthDatabase["config_health_entries"]>;
type ConfigHealthInsert = Insertable<ConfigHealthDatabase["config_health_entries"]>;

function configHealthDbOptions(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): OpenClawStateDatabaseOptions {
  return {
    env: {
      ...env,
      HOME: env.HOME ?? homedir(),
    },
  };
}

function parseFingerprint(value: string | null): ConfigHealthFingerprint | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? (parsed as ConfigHealthFingerprint) : undefined;
  } catch {
    return undefined;
  }
}

function rowToConfigHealthEntry(row: ConfigHealthRow): ConfigHealthEntry {
  const entry: ConfigHealthEntry = {};
  const lastKnownGood = parseFingerprint(row.last_known_good_json);
  if (lastKnownGood) {
    entry.lastKnownGood = lastKnownGood;
  }
  const lastPromotedGood = parseFingerprint(row.last_promoted_good_json);
  if (lastPromotedGood) {
    entry.lastPromotedGood = lastPromotedGood;
  }
  if (row.last_observed_suspicious_signature !== null) {
    entry.lastObservedSuspiciousSignature = row.last_observed_suspicious_signature;
  }
  return entry;
}

function configHealthEntryToRow(configPath: string, entry: ConfigHealthEntry): ConfigHealthInsert {
  return {
    config_path: configPath,
    last_known_good_json: entry.lastKnownGood ? JSON.stringify(entry.lastKnownGood) : null,
    last_promoted_good_json: entry.lastPromotedGood ? JSON.stringify(entry.lastPromotedGood) : null,
    last_observed_suspicious_signature: entry.lastObservedSuspiciousSignature ?? null,
    updated_at_ms: Date.now(),
  };
}

function normalizeConfigHealthState(value: unknown): ConfigHealthState {
  if (!isRecord(value)) {
    return {};
  }
  const entries = isRecord(value.entries) ? value.entries : undefined;
  if (!entries) {
    return {};
  }
  const normalized: Record<string, ConfigHealthEntry> = {};
  for (const [configPath, entry] of Object.entries(entries)) {
    if (typeof configPath === "string" && isRecord(entry)) {
      normalized[configPath] = entry as ConfigHealthEntry;
    }
  }
  return { entries: normalized };
}

export function readConfigHealthStateFromSqlite(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): ConfigHealthState {
  try {
    const database = openOpenClawStateDatabase(configHealthDbOptions(env, homedir));
    const db = getNodeSqliteKysely<ConfigHealthDatabase>(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db.selectFrom("config_health_entries").selectAll().orderBy("config_path", "asc"),
    ).rows;
    const entries: Record<string, ConfigHealthEntry> = {};
    for (const row of rows) {
      entries[row.config_path] = rowToConfigHealthEntry(row);
    }
    return Object.keys(entries).length > 0 ? { entries } : {};
  } catch {
    return {};
  }
}

export function writeConfigHealthStateToSqlite(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
  state: ConfigHealthState,
): void {
  const normalized = normalizeConfigHealthState(state);
  const entries = Object.entries(normalized.entries ?? {});
  const rows = entries.map(([configPath, entry]) => configHealthEntryToRow(configPath, entry));
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<ConfigHealthDatabase>(database.db);
      if (rows.length === 0) {
        executeSqliteQuerySync(database.db, db.deleteFrom("config_health_entries"));
        return;
      }
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("config_health_entries").where(
          "config_path",
          "not in",
          rows.map((row) => row.config_path),
        ),
      );
      for (const row of rows) {
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("config_health_entries")
            .values(row)
            .onConflict((conflict) =>
              conflict.column("config_path").doUpdateSet({
                last_known_good_json: (eb) => eb.ref("excluded.last_known_good_json"),
                last_promoted_good_json: (eb) => eb.ref("excluded.last_promoted_good_json"),
                last_observed_suspicious_signature: (eb) =>
                  eb.ref("excluded.last_observed_suspicious_signature"),
                updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
              }),
            ),
        );
      }
    },
    configHealthDbOptions(env, homedir),
  );
}
