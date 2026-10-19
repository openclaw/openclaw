import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import type { UserProfileMutationContext } from "./user-profile-mutation.js";
import { type UserProfileRow, userProfilesDb } from "./user-profiles-internal.js";
import { UserProfileOwnerError } from "./user-profiles-schema.js";

// A dot keeps the local owner outside Tailscale's provider-suffix namespace.
const OWNER_PROVIDER = "gateway.local";
const OWNER_SUBJECT = "owner";

/** Read raw rows: the shared owner must never inherit a person through a merge. */
export function readGatewayOwnerProfileRows(db: EngineConnection) {
  const kysely = userProfilesDb(db);
  const rows = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("user_profiles")
      .selectAll()
      .select((eb) => eb.val<"owner" | "identified">("owner").as("origin"))
      .where("id", "=", GATEWAY_OWNER_PROFILE_ID)
      .unionAll(
        kysely
          .selectFrom("user_profiles")
          .innerJoin(
            "user_profile_identities",
            "user_profile_identities.profile_id",
            "user_profiles.id",
          )
          .selectAll("user_profiles")
          .select((eb) => eb.val<"owner" | "identified">("identified").as("origin"))
          .where("provider", "=", OWNER_PROVIDER)
          .where("subject", "=", OWNER_SUBJECT),
      ),
  ).rows;
  const result: { owner?: UserProfileRow; identified?: UserProfileRow } = {};
  for (const { origin, ...row } of rows) {
    result[origin] = row;
  }
  return result;
}

export function readGatewayOwnerProfileForEnsure(db: EngineConnection) {
  const { owner, identified } = readGatewayOwnerProfileRows(db);
  if (
    owner?.merged_into ||
    identified?.merged_into ||
    (owner && identified && owner.id !== identified.id)
  ) {
    throw new UserProfileOwnerError("repair-required");
  }
  return { existing: owner ?? identified, identified };
}

/** Queue roster invalidation only for actual changes, after the owning transaction commits. */
export function ensureGatewayOwnerProfileRow(
  db: EngineConnection,
  displayName: string | null,
  mutation?: UserProfileMutationContext,
): UserProfileRow {
  const { existing, identified } = readGatewayOwnerProfileForEnsure(db);
  const kysely = userProfilesDb(db);
  const now = Date.now();
  mutation?.before(db, existing?.id ?? GATEWAY_OWNER_PROFILE_ID);
  const row: UserProfileRow = existing
    ? {
        ...existing,
        display_name:
          existing.display_name?.trim() || !displayName ? existing.display_name : displayName,
      }
    : {
        id: GATEWAY_OWNER_PROFILE_ID,
        display_name: displayName,
        avatar: null,
        avatar_mime: null,
        avatar_sha256: null,
        merged_into: null,
        created_at: now,
        updated_at: now,
      };
  if (!existing) {
    executeSqliteQuerySync(db, kysely.insertInto("user_profiles").values(row));
  } else if (row.display_name !== existing.display_name) {
    row.updated_at = now;
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("user_profiles")
        .set({ display_name: row.display_name, updated_at: now })
        .where("id", "=", row.id),
    );
  }
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("user_profile_identities")
      .values({
        provider: OWNER_PROVIDER,
        subject: OWNER_SUBJECT,
        profile_id: row.id,
        canonical_login: null,
        created_at: now,
      })
      .onConflict((conflict) => conflict.columns(["provider", "subject"]).doNothing()),
  );
  if (!existing || row.display_name !== existing.display_name || !identified) {
    mutation?.publish(row.id);
    publishUserProfilesChange(db, row.id);
  }
  return row;
}
