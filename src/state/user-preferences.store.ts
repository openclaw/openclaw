import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { USER_PREFS_PROFILE_KEY_LIMIT } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema.js";
import type {
  PreparedUserPreferenceUpdate,
  UserPreferenceError,
} from "./user-preferences.types.js";

type UserPreferencesDatabase = Pick<OpenClawStateKyselyDatabase, "user_preferences">;

export const ensureUserPreferencesSchema = createOpenClawStateSchemaEnsurer({
  table: "user_preferences",
  operationLabel: "users.preferences.schema.ensure",
});

export function deleteUserPreference(database: DatabaseSync, profileId: string, key: string): void {
  const db = getNodeSqliteKysely<UserPreferencesDatabase>(database);
  if (!tableExists(database, "user_preferences")) {
    return;
  }
  executeSqliteQuerySync(
    database,
    db
      .deleteFrom("user_preferences")
      .where("profile_id", "=", profileId)
      .where("pref_key", "=", key),
  );
}

export function selectUserPreferenceValues(
  database: DatabaseSync,
  profileIds: readonly string[],
  key: string,
): Map<string, unknown> {
  if (profileIds.length === 0 || !tableExists(database, "user_preferences")) {
    return new Map();
  }
  const rows = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<UserPreferencesDatabase>(database)
      .selectFrom("user_preferences")
      .select(["profile_id", "value_json"])
      .where("profile_id", "in", [...profileIds])
      .where("pref_key", "=", key),
  ).rows;
  return new Map(
    rows.map((row) => [row.profile_id, JSON.parse(row.value_json) as unknown] as const),
  );
}

function readPreferenceKeys(database: DatabaseSync, profileId: string): Set<string> {
  const db = getNodeSqliteKysely<UserPreferencesDatabase>(database);
  return new Set(
    executeSqliteQuerySync(
      database,
      db.selectFrom("user_preferences").select("pref_key").where("profile_id", "=", profileId),
    ).rows.map((row) => row.pref_key),
  );
}

/** Moves one retired profile's preferences without overwriting the merge target's choices. */
export function mergeUserPreferences(
  database: DatabaseSync,
  sourceProfileId: string,
  targetProfileId: string,
): void {
  if (sourceProfileId === targetProfileId || !tableExists(database, "user_preferences")) {
    return;
  }
  const db = getNodeSqliteKysely<UserPreferencesDatabase>(database);
  const targetKeys = readPreferenceKeys(database, targetProfileId);
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("user_preferences")
      .selectAll()
      .where("profile_id", "=", sourceProfileId)
      .orderBy("pref_key", "asc"),
  ).rows;
  for (const row of rows) {
    if (targetKeys.has(row.pref_key)) {
      continue;
    }
    if (targetKeys.size >= USER_PREFS_PROFILE_KEY_LIMIT) {
      break;
    }
    executeSqliteQuerySync(
      database,
      db
        .insertInto("user_preferences")
        .values({ ...row, profile_id: targetProfileId })
        .onConflict((conflict) => conflict.columns(["profile_id", "pref_key"]).doNothing()),
    );
    targetKeys.add(row.pref_key);
  }
  executeSqliteQuerySync(
    database,
    db.deleteFrom("user_preferences").where("profile_id", "=", sourceProfileId),
  );
}

export function readUserPreferences(
  sqlite: DatabaseSync,
  profileId: string,
  keys?: readonly string[],
): Record<string, unknown> {
  if (keys?.length === 0) {
    return {};
  }
  const kysely = getNodeSqliteKysely<UserPreferencesDatabase>(sqlite);
  let query = kysely
    .selectFrom("user_preferences")
    .select(["pref_key", "value_json"])
    .where("profile_id", "=", profileId)
    .orderBy("pref_key", "asc");
  if (keys) {
    query = query.where("pref_key", "in", [...keys]);
  }
  return Object.fromEntries(
    executeSqliteQuerySync(sqlite, query).rows.map((row) => [
      row.pref_key,
      JSON.parse(row.value_json) as unknown,
    ]),
  );
}

export function writeUserPreferences(
  sqlite: DatabaseSync,
  profileId: string,
  { serialized, deletionKeys, expected }: PreparedUserPreferenceUpdate,
): Result<void, UserPreferenceError> {
  if (expected.length > 0) {
    const current = readUserPreferences(
      sqlite,
      profileId,
      expected.map(({ prefKey }) => prefKey),
    );
    for (const { prefKey, valueJson } of expected) {
      if (
        valueJson === null
          ? Object.hasOwn(current, prefKey)
          : !Object.hasOwn(current, prefKey) ||
            !isDeepStrictEqual(current[prefKey], JSON.parse(valueJson))
      ) {
        return err({ code: "conflict" });
      }
    }
  }
  const db = getNodeSqliteKysely<UserPreferencesDatabase>(sqlite);
  const currentKeys = readPreferenceKeys(sqlite, profileId);
  const nextKeys = new Set(currentKeys);
  deletionKeys.forEach((key) => nextKeys.delete(key));
  serialized.forEach((entry) => nextKeys.add(entry.prefKey));
  if (serialized.length > 0 && nextKeys.size > USER_PREFS_PROFILE_KEY_LIMIT) {
    return err({
      code: "profile-key-limit",
      limit: USER_PREFS_PROFILE_KEY_LIMIT,
      currentCount: currentKeys.size,
    });
  }
  if (deletionKeys.length > 0) {
    executeSqliteQuerySync(
      sqlite,
      db
        .deleteFrom("user_preferences")
        .where("profile_id", "=", profileId)
        .where("pref_key", "in", deletionKeys),
    );
  }
  const updatedAtMs = Date.now();
  if (serialized.length > 0) {
    executeSqliteQuerySync(
      sqlite,
      db
        .insertInto("user_preferences")
        .values(
          serialized.map((entry) => ({
            profile_id: profileId,
            pref_key: entry.prefKey,
            value_json: entry.valueJson,
            updated_at_ms: updatedAtMs,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(["profile_id", "pref_key"]).doUpdateSet({
            value_json: (eb) => eb.ref("excluded.value_json"),
            updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
          }),
        ),
    );
  }
  return ok(undefined);
}
