import {
  normalizeGitCoauthorOrganizationIdentity,
  GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY,
} from "../../packages/gateway-protocol/src/schema/git-coauthor-identity.js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  GIT_COAUTHOR_PREFERENCE_KEY,
  isGitCoauthorCreditEnabled,
} from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { selectEnterpriseGitHubIdentities } from "./user-profile-enterprise-github-identity.js";
import { projectStoredGitHubIdentities } from "./user-profile-github-projection.js";
import type {
  EnterpriseGitHubIdentity,
  UserProfileGitHubAttributionRead,
  UserProfilesDatabase,
} from "./user-profiles.types.js";

const GITHUB_PROVIDER = "github";

export function readUserProfileGitAttribution(
  db: EngineConnection,
  profileIds: readonly string[],
  host = "github.com",
  organizationDefaults?: string,
  githubAvailability = false,
): UserProfileGitHubAttributionRead {
  if (profileIds.length === 0 || !tableExists(db, "user_profiles")) {
    return { identities: new Map(), canonicalProfileIds: [] };
  }
  const query = getNodeSqliteKysely<UserProfilesDatabase & Pick<DB, "user_preferences">>(db)
    .selectFrom("user_profiles as requested")
    .leftJoin("user_profiles as profile", (join) =>
      join.on((eb) =>
        eb("profile.id", "=", eb.fn.coalesce("requested.merged_into", "requested.id")),
      ),
    )
    .select(["requested.id as source_id"])
    .select((eb) => [
      eb.fn.coalesce("requested.merged_into", "requested.id").as("profile_id"),
      tableHasColumn(db, "user_profiles", "primary_github_account_id")
        ? "profile.primary_github_account_id"
        : eb.val<number | null>(null).as("primary_github_account_id"),
    ])
    .where("requested.id", "in", [...profileIds]);
  const withPreferences = tableExists(db, "user_preferences")
    ? query
        .leftJoin("user_preferences as preference", (join) =>
          join
            .onRef("preference.profile_id", "=", "profile.id")
            .on("preference.pref_key", "=", GIT_COAUTHOR_PREFERENCE_KEY),
        )
        .leftJoin("user_preferences as organization", (join) =>
          join
            .onRef("organization.profile_id", "=", "profile.id")
            .on("organization.pref_key", "=", GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY),
        )
        .select(["preference.value_json", "organization.value_json as organization_json"])
    : query.select((eb) => [
        eb.val<string | null>(null).as("value_json"),
        eb.val<string | null>(null).as("organization_json"),
      ]);
  const rows = executeSqliteQuerySync(
    db,
    host === "github.com" && tableHasColumn(db, "user_profile_identities", "canonical_login")
      ? withPreferences
          .leftJoin("user_profile_identities as identity", (join) =>
            join
              .onRef("identity.profile_id", "=", "profile.id")
              .on("identity.provider", "=", GITHUB_PROVIDER)
              .on("identity.canonical_login", "is not", null),
          )
          .select(["identity.subject", "identity.canonical_login"])
          .orderBy("identity.subject", "asc")
      : withPreferences.select((eb) => [
          eb.val<string | null>(null).as("subject"),
          eb.val<string | null>(null).as("canonical_login"),
        ]),
  ).rows;
  const canonicalBySource = new Map(rows.map((row) => [row.source_id, row.profile_id] as const));
  const canonicalIds = [...new Set(canonicalBySource.values())];
  // Key by the requested alias so multiple aliases cannot duplicate a primary's accounts.
  const identities = projectStoredGitHubIdentities(
    rows.map((row) => ({ ...row, profile_id: row.source_id })),
  );
  const enterprise =
    host !== "github.com"
      ? selectEnterpriseGitHubIdentities(db, canonicalIds, host)
      : new Map<string, EnterpriseGitHubIdentity>();
  const preferences = new Map(
    rows.map((row) => [
      row.source_id,
      row.value_json === null ? undefined : (JSON.parse(row.value_json) as unknown),
    ]),
  );
  const creditPairs = new Map(
    rows.map((row) => {
      const organization =
        !organizationDefaults || row.organization_json === null
          ? undefined
          : normalizeGitCoauthorOrganizationIdentity(JSON.parse(row.organization_json));
      return [
        row.source_id,
        organization?.policy === organizationDefaults ? organization : undefined,
      ] as const;
    }),
  );
  return {
    identities: new Map(
      [...canonicalBySource].map(([sourceId, canonicalId]) => {
        if (canonicalId === GATEWAY_OWNER_PROFILE_ID) {
          return [sourceId, null];
        }
        const enterpriseIdentity = enterprise.get(canonicalId);
        const identity =
          host !== "github.com"
            ? (enterpriseIdentity ?? null)
            : (identities.get(sourceId)?.primary ?? null);
        const fallback =
          host !== "github.com" && !enterpriseIdentity?.verifiedEmail ? null : identity;
        const preference = githubAvailability ? true : preferences.get(sourceId);
        const pair = githubAvailability ? undefined : creditPairs.get(sourceId);
        const credit = pair
          ? preference === true
            ? {
                name: pair.name,
                email: pair.email,
                ...(identity ? { accountId: identity.accountId, githubLogin: identity.login } : {}),
              }
            : null
          : fallback;
        return [sourceId, isGitCoauthorCreditEnabled(preference) ? credit : null];
      }),
    ),
    canonicalProfileIds: canonicalIds,
  };
}
