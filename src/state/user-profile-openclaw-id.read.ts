import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  openClawIdProfileProvider,
  type OpenClawIdUserProfiles,
} from "./user-profile-openclaw-id.types.js";
import { userProfilesDb } from "./user-profiles-internal.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

// The provider-specific discriminator excludes every GitHub verified-email proof format.
function readDisplayEmail(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    const metadata: unknown = JSON.parse(value);
    return isRecord(metadata) &&
      metadata.kind === "openclaw-id-display" &&
      typeof metadata.email === "string"
      ? metadata.email
      : null;
  } catch {
    return null;
  }
}

/** Reads a batched OCID display cohort in one worker snapshot, following explicit merges. */
export function readOpenClawIdUserProfilesInDatabase(
  db: EngineConnection,
  accountIds: readonly string[],
): OpenClawIdUserProfiles {
  if (
    accountIds.length === 0 ||
    !tableExists(db, "user_profile_identities") ||
    !tableExists(db, "user_profiles")
  ) {
    return {};
  }
  return runSqliteReadSnapshotSync(db, () => {
    const kysely = userProfilesDb(db);
    const identities = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("user_profile_identities")
        .select(["subject", "profile_id", "verified_email_json"])
        .where("provider", "=", openClawIdProfileProvider)
        .where("subject", "in", [...new Set(accountIds)]),
    ).rows;
    if (!identities.length) {
      return {};
    }
    // Select only the requested profile rows and their canonical merge heads, never the roster.
    const ids = [...new Set(identities.map((identity) => identity.profile_id))];
    const profiles = kysely.selectFrom("user_profiles");
    const rows = executeSqliteQuerySync(
      db,
      profiles
        .select(["id", "display_name", "merged_into"])
        .where((eb) =>
          eb.or([
            eb("id", "in", ids),
            eb("id", "in", profiles.select("merged_into").where("id", "in", ids)),
          ]),
        ),
    ).rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    return Object.fromEntries(
      identities.flatMap((identity) => {
        const raw = byId.get(identity.profile_id);
        const profile = raw?.merged_into ? (byId.get(raw.merged_into) ?? raw) : raw;
        return profile
          ? [
              [
                identity.subject,
                {
                  id: profile.id,
                  displayName: profile.display_name,
                  email: readDisplayEmail(identity.verified_email_json),
                },
              ],
            ]
          : [];
      }),
    );
  });
}

/**
 * The canonical profile an OCID account is linked to (following merges), with its update
 * time for connection admission, or null when the account has no profile.
 */
export function readOpenClawIdLinkedProfileInDatabase(
  db: EngineConnection,
  accountId: string,
): { profileId: string; updatedAt: number } | null {
  if (!tableExists(db, "user_profile_identities") || !tableExists(db, "user_profiles")) {
    return null;
  }
  return runSqliteReadSnapshotSync(db, () => {
    const kysely = userProfilesDb(db);
    const identity = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("user_profile_identities")
        .select("profile_id")
        .where("provider", "=", openClawIdProfileProvider)
        .where("subject", "=", accountId),
    ).rows[0];
    if (!identity) {
      return null;
    }
    const row = (id: string) =>
      executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("user_profiles")
          .select(["id", "updated_at", "merged_into"])
          .where("id", "=", id),
      ).rows[0];
    const linked = row(identity.profile_id);
    const profile = linked?.merged_into ? row(linked.merged_into) : linked;
    return profile ? { profileId: profile.id, updatedAt: profile.updated_at } : null;
  });
}

/** The OCID accounts linked to a profile (several after a merge), oldest first. */
export function readOpenClawIdLinksOfProfileInDatabase(
  db: EngineConnection,
  profileId: string,
): Array<{ accountId: string; email: string | null }> {
  if (!tableExists(db, "user_profile_identities")) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_identities")
      .select(["subject", "verified_email_json"])
      .where("provider", "=", openClawIdProfileProvider)
      .where("profile_id", "=", profileId)
      .orderBy("created_at"),
  ).rows.map((identity) => ({
    accountId: identity.subject,
    email: readDisplayEmail(identity.verified_email_json),
  }));
}

export const openClawIdUserProfileReadOperations = {
  "userProfiles.openClawId.read": ({ accountIds }: { accountIds: readonly string[] }, db) => ({
    type: "userProfiles.openClawId.read" as const,
    profiles: readOpenClawIdUserProfilesInDatabase(db, accountIds),
  }),
  "userProfiles.openClawId.linkedProfile": ({ accountId }: { accountId: string }, db) => ({
    type: "userProfiles.openClawId.linkedProfile" as const,
    profile: readOpenClawIdLinkedProfileInDatabase(db, accountId),
  }),
  "userProfiles.openClawId.linksOf": ({ profileId }: { profileId: string }, db) => ({
    type: "userProfiles.openClawId.linksOf" as const,
    links: readOpenClawIdLinksOfProfileInDatabase(db, profileId),
  }),
} satisfies WorkerOperationHandlers<EngineConnection>;
