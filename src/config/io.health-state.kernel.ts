import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type {
  ConfigHealthEntry,
  ConfigHealthEntryChanges,
  ConfigHealthEntryBasis,
  ConfigHealthSnapshot,
  ConfigHealthFingerprint,
  ConfigHealthState,
} from "./io.health-state.types.js";

type ConfigHealthDatabase = Pick<DB, "config_health_entries">;
type ConfigHealthWriteRow = Insertable<ConfigHealthDatabase["config_health_entries"]>;
export type ConfigHealthPatch = Partial<
  Pick<
    ConfigHealthWriteRow,
    "last_known_good_json" | "last_promoted_good_json" | "last_observed_suspicious_signature"
  >
>;

function parseFingerprint(value: string | null): ConfigHealthFingerprint | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    // SAFETY: Preserve the existing persisted fingerprint object's permissive read contract.
    return parsed && typeof parsed === "object" ? (parsed as ConfigHealthFingerprint) : undefined;
  } catch {
    return undefined;
  }
}

function stringifyFingerprint(value: ConfigHealthFingerprint | null | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function selectConfigHealthRows(db: DatabaseSync, configPath?: string) {
  let query = getNodeSqliteKysely<ConfigHealthDatabase>(db)
    .selectFrom("config_health_entries")
    .select([
      "config_path",
      "last_known_good_json",
      "last_promoted_good_json",
      "last_observed_suspicious_signature",
      "updated_at_ms",
    ]);
  if (configPath !== undefined) {
    query = query.where("config_path", "=", configPath);
  }
  return executeSqliteQuerySync(db, query.orderBy("config_path", "asc")).rows;
}

function decodeConfigHealthRows(
  rows: ReturnType<typeof selectConfigHealthRows>,
): ConfigHealthState {
  return {
    entries: Object.fromEntries(
      rows.map((row) => [
        row.config_path,
        {
          lastKnownGood: parseFingerprint(row.last_known_good_json),
          lastPromotedGood: parseFingerprint(row.last_promoted_good_json),
          lastObservedSuspiciousSignature: row.last_observed_suspicious_signature,
        } satisfies ConfigHealthEntry,
      ]),
    ),
  };
}

export function readConfigHealthStateInDatabase(db: DatabaseSync): ConfigHealthState {
  return decodeConfigHealthRows(selectConfigHealthRows(db));
}

export function readConfigHealthSnapshotInDatabase(db: DatabaseSync): ConfigHealthSnapshot {
  const rows = selectConfigHealthRows(db);
  return {
    state: decodeConfigHealthRows(rows),
    basis: Object.fromEntries(
      rows.map((row) => [
        row.config_path,
        {
          lastKnownGoodJson: row.last_known_good_json,
          lastPromotedGoodJson: row.last_promoted_good_json,
          suspiciousSignature: row.last_observed_suspicious_signature,
          updatedAtMs: row.updated_at_ms,
        } satisfies ConfigHealthEntryBasis,
      ]),
    ),
  };
}

/** Omitted fields remain untouched; explicit undefined and null clear their stored value. */
export function prepareConfigHealthPatch(changes: ConfigHealthEntryChanges): ConfigHealthPatch {
  return {
    ...(Object.hasOwn(changes, "lastKnownGood")
      ? { last_known_good_json: stringifyFingerprint(changes.lastKnownGood) }
      : {}),
    ...(Object.hasOwn(changes, "lastPromotedGood")
      ? { last_promoted_good_json: stringifyFingerprint(changes.lastPromotedGood) }
      : {}),
    ...(Object.hasOwn(changes, "lastObservedSuspiciousSignature")
      ? { last_observed_suspicious_signature: changes.lastObservedSuspiciousSignature ?? null }
      : {}),
  };
}

/** Compare the original read and merge in one write transaction, preserving untouched JSON. */
export function patchConfigHealthEntryInDatabase(
  db: DatabaseSync,
  configPath: string,
  patch: ConfigHealthPatch,
  expected: ConfigHealthEntryBasis | null | undefined,
  updatedAtMs: number,
): boolean {
  const current = selectConfigHealthRows(db, configPath)[0];
  if (expected === undefined) {
    return false;
  }
  if (expected === null) {
    if (current !== undefined) {
      return false;
    }
  } else if (
    current === undefined ||
    current.last_known_good_json !== expected.lastKnownGoodJson ||
    current.last_promoted_good_json !== expected.lastPromotedGoodJson ||
    current.last_observed_suspicious_signature !== expected.suspiciousSignature ||
    current.updated_at_ms !== expected.updatedAtMs
  ) {
    return false;
  }
  writeConfigHealthPatchInDatabase(db, configPath, patch, updatedAtMs);
  return true;
}

/** The caller owns the transaction; omitted fields and sibling paths remain unchanged. */
export function writeConfigHealthPatchInDatabase(
  db: DatabaseSync,
  configPath: string,
  patch: ConfigHealthPatch,
  updatedAtMs: number,
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ConfigHealthDatabase>(db)
      .insertInto("config_health_entries")
      .values({
        config_path: configPath,
        last_known_good_json: null,
        last_promoted_good_json: null,
        last_observed_suspicious_signature: null,
        ...patch,
        updated_at_ms: updatedAtMs,
      })
      .onConflict((conflict) =>
        conflict.column("config_path").doUpdateSet({
          ...patch,
          updated_at_ms: updatedAtMs,
        }),
      ),
  );
}
