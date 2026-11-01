import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { parseUserModelAuthProfileId } from "./user-model-account-id.js";
import type { UserProfilesDatabase } from "./user-profiles.types.js";

export type UserModelAccountRecordName = "model-accounts" | `model-account:${string}`;

export function invalidUserModelAccounts(): Error {
  return new Error("Personal model account state is invalid; restore a verified state backup.");
}

export function readUserModelAccountRecord(
  db: EngineConnection,
  owner: string,
  name: UserModelAccountRecordName,
): string | undefined {
  if (!tableExists(db, "secret_store_entries")) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
      .selectFrom("secret_store_entries")
      .select(["value", "kind", "allowed_hosts"])
      .where("scope_kind", "=", "identity")
      .where("scope_id", "=", owner)
      .where("name", "=", name)
      .where("deleted_at_ms", "is", null),
  );
  return row ? userModelAccountRecordValue(row) : undefined;
}

export function userModelAccountRecordValue(row: {
  value: string | null;
  kind: string | null;
  allowed_hosts: string | null;
}): string {
  if (row.kind !== "secret" || row.allowed_hosts !== null || row.value === null) {
    throw invalidUserModelAccounts();
  }
  return row.value;
}

function readUserModelAccountRecords(
  db: EngineConnection,
  selected: readonly { owner: string; name: UserModelAccountRecordName }[],
) {
  if (
    selected.length === 0 ||
    !tableExists(db, "user_profiles") ||
    !tableExists(db, "secret_store_entries")
  ) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<UserProfilesDatabase & Pick<DB, "secret_store_entries">>(db)
      .selectFrom("user_profiles as source")
      .leftJoin("user_profiles as target", "target.id", "source.merged_into")
      .innerJoin("secret_store_entries", (join) =>
        join.on((eb) =>
          eb(
            "secret_store_entries.scope_id",
            "=",
            eb
              .case()
              .when(
                eb.or([eb("source.merged_into", "is", null), eb("source.merged_into", "=", "")]),
              )
              .then(eb.ref("source.id"))
              .else(eb.ref("target.id"))
              .end(),
          ),
        ),
      )
      .select(["name", "value", "kind", "allowed_hosts"])
      .where("scope_kind", "=", "identity")
      .where("deleted_at_ms", "is", null)
      // The one-hop owner must be live; orphaned tombstones never yield secrets.
      .where((eb) =>
        eb.or([
          eb("source.merged_into", "is", null),
          eb("source.merged_into", "=", ""),
          eb.and([
            eb("target.id", "is not", null),
            eb.or([eb("target.merged_into", "is", null), eb("target.merged_into", "=", "")]),
          ]),
        ]),
      )
      .where((eb) =>
        eb.or(
          selected.map(({ owner, name }) =>
            eb.and([eb("source.id", "=", owner), eb("name", "=", name)]),
          ),
        ),
      ),
  ).rows;
}

export function readUserModelAccountLinksRecord(
  db: EngineConnection,
  profileId: string,
): string | undefined {
  const row = readUserModelAccountRecords(db, [{ owner: profileId, name: "model-accounts" }])[0];
  return row ? userModelAccountRecordValue(row) : undefined;
}

/** Read only selected records through their current one-hop owners, preserving selection order. */
export function readSelectedUserModelAccountRecords(
  db: EngineConnection,
  profileIds: readonly string[],
) {
  const selected = [...new Set(profileIds)].flatMap((id) => {
    const locator = parseUserModelAuthProfileId(id);
    return locator ? [{ id, owner: locator.ownerProfileId }] : [];
  });
  const rows = readUserModelAccountRecords(
    db,
    selected.map(({ id, owner }) => ({ owner, name: `model-account:${id}` })),
  );
  const records = new Map(rows.map((row) => [row.name, row]));
  return selected.flatMap(({ id }) => {
    const row = records.get(`model-account:${id}`);
    return row ? [{ id, ...row }] : [];
  });
}
