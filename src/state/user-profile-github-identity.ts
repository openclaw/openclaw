import {
  GATEWAY_OWNER_PROFILE_ID,
  GIT_COAUTHOR_PREFERENCE_KEY,
  isGitCoauthorCreditEnabled,
} from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { UserProfileGitHubIdentity } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import type { OpenClawStateReadCommand } from "./openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { deleteUserPreference } from "./user-preferences.store.js";
import {
  selectEnterpriseGitHubIdentities,
  selectEnterpriseGitHubProfileIdsForMerge,
} from "./user-profile-enterprise-github-identity.js";
import {
  captureUserProfileAuthorityRead,
  publishUserProfileAuthorityChange,
} from "./user-profile-events.js";
import type { UserProfileMutationContext } from "./user-profile-mutation.js";
import {
  selectProfileDisplayEntries,
  selectUserProfileEmailAlias,
  selectResolvedUserProfileMetadataById,
  setUserProfileEmailBinding,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { UserProfileOwnerError } from "./user-profiles-schema.js";
import type {
  CachedGitHubIdentity,
  CachedGitHubIdentityBinding,
  StoredGitHubIdentity,
  ProfileDisplayRow,
  UserProfileGitHubAttribution,
  UserProfileGitHubAttributionRead,
  UserProfileRoleAuthority,
  UserProfilesDatabase,
  EnterpriseGitHubIdentity,
} from "./user-profiles.types.js";

const GITHUB_PROVIDER = "github";
const GITHUB_LOGIN_SUBJECT_PREFIX = "login:";
export function selectStoredGitHubIdentities(
  db: EngineConnection,
  profileIds?: readonly string[],
  accountIds?: readonly number[],
): Map<string, { accounts: StoredGitHubIdentity[]; primary: StoredGitHubIdentity | undefined }> {
  if (profileIds?.length === 0 || accountIds?.length === 0) {
    return new Map();
  }
  if (!tableHasColumn(db, "user_profile_identities", "canonical_login")) {
    return new Map();
  }
  let query = userProfilesDb(db)
    .selectFrom("user_profile_identities")
    .innerJoin("user_profiles", "user_profiles.id", "user_profile_identities.profile_id")
    .select(["profile_id", "subject", "canonical_login"])
    // Read-only catalog projections must not initialize a pre-feature database.
    .select((eb) => [
      tableHasColumn(db, "user_profiles", "primary_github_account_id")
        ? "user_profiles.primary_github_account_id"
        : eb.val<number | null>(null).as("primary_github_account_id"),
    ])
    .where("provider", "=", GITHUB_PROVIDER)
    .where("canonical_login", "is not", null)
    .orderBy("subject", "asc");
  if (profileIds) {
    query = query.where("profile_id", "in", [...profileIds]);
  }
  if (accountIds) {
    query = query
      .where("subject", "in", accountIds.map(String))
      .where("user_profiles.merged_into", "is", null);
  }
  return projectStoredGitHubIdentities(executeSqliteQuerySync(db, query).rows);
}

function projectStoredGitHubIdentities(
  rows: readonly {
    profile_id: string;
    subject: string | null;
    canonical_login: string | null;
    primary_github_account_id?: number | null;
  }[],
): Map<string, { accounts: StoredGitHubIdentity[]; primary: StoredGitHubIdentity | undefined }> {
  const profiles = new Map<
    string,
    { accounts: StoredGitHubIdentity[]; primaryId: number | null }
  >();
  for (const row of rows) {
    const accountId = Number(row.subject);
    const login = row.canonical_login ? normalizeGitHubLogin(row.canonical_login) : undefined;
    if (!login || !Number.isSafeInteger(accountId) || accountId <= 0) {
      continue;
    }
    const profile = profiles.get(row.profile_id) ?? {
      accounts: [],
      primaryId: row.primary_github_account_id ?? null,
    };
    profile.accounts.push({ accountId, login });
    profiles.set(row.profile_id, profile);
  }
  return new Map(
    [...profiles].map(([id, { accounts, primaryId }]) => [
      id,
      {
        accounts,
        // Old single-account profiles have an unambiguous primary; never pick one from several.
        primary:
          primaryId === null && accounts.length === 1
            ? accounts[0]
            : accounts.find((account) => account.accountId === primaryId),
      },
    ]),
  );
}

/** One statement keeps canonical ownership, role, and verified login in the same snapshot. */
export function selectUserProfileRoleAuthority(
  db: EngineConnection,
  profileId: string,
): UserProfileRoleAuthority | undefined {
  if (!tableExists(db, "user_profiles")) {
    return undefined;
  }
  const hasRole = getAdmittedSqliteSchemaFacts(db) && tableHasColumn(db, "user_profiles", "role");
  const query = userProfilesDb(db)
    .selectFrom("user_profiles as requested")
    .leftJoin("user_profiles as canonical", (join) =>
      join
        .onRef("canonical.id", "=", "requested.merged_into")
        .on("requested.merged_into", "!=", ""),
    )
    .innerJoin("user_profiles as profile", (join) =>
      join.on((eb) => eb("profile.id", "=", eb.fn.coalesce("canonical.id", "requested.id"))),
    )
    .where("requested.id", "=", profileId)
    .select("profile.id as profile_id")
    .select((eb) => [
      hasRole ? "profile.role" : eb.val<string | null>(null).as("role"),
      tableHasColumn(db, "user_profiles", "primary_github_account_id")
        ? "profile.primary_github_account_id"
        : eb.val<number | null>(null).as("primary_github_account_id"),
    ]);
  const rows = executeSqliteQuerySync(
    db,
    tableHasColumn(db, "user_profile_identities", "canonical_login")
      ? query
          .leftJoin("user_profile_identities as identity", (join) =>
            join
              .onRef("identity.profile_id", "=", "profile.id")
              .on("identity.provider", "=", GITHUB_PROVIDER)
              .on("identity.canonical_login", "is not", null),
          )
          .select(["identity.subject", "identity.canonical_login"])
          .orderBy("identity.subject", "asc")
      : query.select((eb) => [
          eb.val<string | null>(null).as("subject"),
          eb.val<string | null>(null).as("canonical_login"),
        ]),
  ).rows;
  const profile = rows[0];
  return profile
    ? {
        profileId: profile.profile_id,
        role: profile.role ?? null,
        githubLogin:
          projectStoredGitHubIdentities(rows).get(profile.profile_id)?.primary?.login ?? null,
      }
    : undefined;
}

export function selectProfileAccessEntries(
  db: EngineConnection,
  profileIds?: string[],
): Array<[string, ProfileDisplayRow]> {
  const rows = selectProfileDisplayEntries(db, profileIds);
  if (rows.length === 0) {
    return rows;
  }
  const identities = selectStoredGitHubIdentities(db, profileIds);
  const githubIdentities = projectUserProfileGitHubIdentities(
    identities,
    selectEnterpriseGitHubIdentities(db, profileIds),
  );
  return rows.map(([id, row]) => {
    const identity = identities.get(id);
    const accounts = identity?.accounts;
    return [
      id,
      accounts?.length
        ? {
            ...row,
            githubAccountIds: accounts.map(({ accountId }) => accountId),
            githubLogin: identity?.primary?.login ?? null,
            githubIdentity: githubIdentities.get(id) ?? null,
          }
        : { ...row, githubIdentity: githubIdentities.get(id) ?? null },
    ];
  });
}

function resolveCachedGitHubIdentityInDatabase(
  db: EngineConnection,
  binding: CachedGitHubIdentityBinding,
): CachedGitHubIdentity | undefined {
  if (
    !tableExists(db, "user_profiles") ||
    !tableHasColumn(db, "user_profile_identities", "canonical_login")
  ) {
    return undefined;
  }
  const login = "login" in binding ? normalizeGitHubLogin(binding.login)?.toLowerCase() : undefined;
  const accountBinding = "email" in binding ? binding : undefined;
  const email = accountBinding?.email.trim().toLowerCase();
  const alias = login
    ? selectGitHubProfileAlias(db, {
        kind: "github-login",
        subject: githubAuthenticationSubject(login),
      })
    : email &&
        accountBinding &&
        Number.isSafeInteger(accountBinding.accountId) &&
        accountBinding.accountId > 0 &&
        tableExists(db, "user_profile_emails")
      ? selectGitHubProfileAlias(db, { kind: "email", email })
      : undefined;
  const profile = alias ? selectResolvedUserProfileMetadataById(db, alias.profile_id) : undefined;
  const accounts = profile
    ? selectStoredGitHubIdentities(db, [profile.id]).get(profile.id)?.accounts
    : undefined;
  // A login alias stays reusable only while its profile's verified account still holds that login.
  return profile &&
    accounts?.some((account) =>
      login
        ? account.login.toLowerCase() === login
        : account.accountId === accountBinding?.accountId,
    )
    ? { profileId: profile.id, updatedAt: profile.updated_at }
    : undefined;
}

export function githubAuthenticationSubject(login: string): string {
  const normalized = login.trim().toLowerCase();
  if (!normalized) {
    throw new TypeError("GitHub login is invalid");
  }
  // Login aliases and immutable numeric account IDs share one SQLite keyspace.
  return `${GITHUB_LOGIN_SUBJECT_PREFIX}${normalized}`;
}

export function selectUserProfileGitHubIdentities(
  db: EngineConnection,
  profileIds?: readonly string[],
): Map<string, UserProfileGitHubIdentity> {
  return projectUserProfileGitHubIdentities(
    selectStoredGitHubIdentities(db, profileIds),
    selectEnterpriseGitHubIdentities(db, profileIds),
  );
}

function projectUserProfileGitHubIdentities(
  publicIdentities: ReturnType<typeof selectStoredGitHubIdentities>,
  enterpriseIdentities: Map<string, EnterpriseGitHubIdentity>,
): Map<string, UserProfileGitHubIdentity> {
  const identities = new Map<string, UserProfileGitHubIdentity>();
  for (const [profileId, { primary }] of publicIdentities) {
    if (primary) {
      identities.set(profileId, projectGitHubIdentity(primary));
    }
  }
  for (const [profileId, identity] of enterpriseIdentities) {
    if (!publicIdentities.has(profileId)) {
      identities.set(profileId, {
        host: identity.host,
        login: identity.login,
        profileUrl: `https://${identity.host}/${identity.login}`,
        avatarUrl: `https://${identity.host}/avatars/u/${identity.accountId}`,
      });
    }
  }
  return identities;
}

function projectGitHubIdentity(primary: StoredGitHubIdentity): UserProfileGitHubIdentity {
  return {
    login: primary.login,
    profileUrl: `https://github.com/${primary.login}`,
    avatarUrl: `https://avatars.githubusercontent.com/u/${primary.accountId}?v=4`,
  };
}

/** Resolves current verified identities and public-credit preferences without initializing storage. */
export async function resolveUserProfileGitHubAttribution(
  profileIds: readonly string[],
  options: OpenClawStateDatabaseOptions & { host?: string } = {},
): Promise<UserProfileGitHubAttribution> {
  if (profileIds.length === 0) {
    return new Map();
  }
  return (await prepareUserProfileGitHubAttribution(profileIds, options)).identities;
}

function resolveUserProfileGitHubAttributionInDatabase(
  db: EngineConnection,
  profileIds: readonly string[],
  host = "github.com",
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
        .select("preference.value_json")
    : query.select((eb) => eb.val<string | null>(null).as("value_json"));
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
  return {
    identities: new Map(
      [...canonicalBySource].map(([sourceId, canonicalId]) => {
        const enterpriseIdentity = enterprise.get(canonicalId);
        const identity =
          host !== "github.com"
            ? enterpriseIdentity?.verifiedEmail
              ? enterpriseIdentity
              : null
            : (identities.get(sourceId)?.primary ?? null);
        return [sourceId, isGitCoauthorCreditEnabled(preferences.get(sourceId)) ? identity : null];
      }),
    ),
    canonicalProfileIds: canonicalIds,
  };
}

type PreparedGitHubAttribution = {
  identities: UserProfileGitHubAttribution;
  isCurrent: () => boolean;
};

const preparedGitHubAttributions = new Map<string, PreparedGitHubAttribution>();

/** Bind public credit to its live profile owner before any later publication awaits. */
export async function prepareUserProfileGitHubAttribution(
  profileIds: readonly string[],
  options: OpenClawStateDatabaseOptions & { host?: string } = {},
): Promise<PreparedGitHubAttribution> {
  const selectedProfileIds = [...profileIds];
  const context = captureOpenClawStateWorkerContext(options);
  const host = options.host ?? "github.com";
  const key = JSON.stringify([context.admission.identity.key, selectedProfileIds, host]);
  const cached = preparedGitHubAttributions.get(key);
  if (cached?.isCurrent()) {
    return { identities: structuredClone(cached.identities), isCurrent: cached.isCurrent };
  }
  preparedGitHubAttributions.delete(key);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const authority = await captureUserProfileAuthorityRead(context.admission);
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "userProfiles.githubAttribution.resolve", profileIds: selectedProfileIds, host },
      { context, current: true },
    );
    context.admission.assertCurrent();
    const isCurrent = authority.bind([
      ...selectedProfileIds,
      ...(reply?.canonicalProfileIds ?? []),
    ]);
    if (isCurrent) {
      const identities: UserProfileGitHubAttribution = reply?.identities ?? new Map();
      // Absent profiles have no owner publication to invalidate a later first creation.
      if (selectedProfileIds.every((profileId) => identities.has(profileId))) {
        preparedGitHubAttributions.set(key, {
          identities: structuredClone(identities),
          isCurrent,
        });
        while (preparedGitHubAttributions.size > 64) {
          preparedGitHubAttributions.delete(preparedGitHubAttributions.keys().next().value!);
        }
      }
      return { identities, isCurrent };
    }
  }
  throw new Error("Git co-author credit changed while preparing attribution");
}

export function readUserProfileGitHubCommand(
  db: EngineConnection,
  command: Extract<
    OpenClawStateReadCommand,
    { type: "userProfiles.githubIdentity.cached" | "userProfiles.githubAttribution.resolve" }
  >,
):
  | { type: "userProfiles.githubIdentity.cached"; identity: CachedGitHubIdentity | undefined }
  | ({ type: "userProfiles.githubAttribution.resolve" } & UserProfileGitHubAttributionRead) {
  if (command.type === "userProfiles.githubIdentity.cached") {
    return runSqliteReadSnapshotSync(db, () => ({
      type: command.type,
      identity: resolveCachedGitHubIdentityInDatabase(db, command),
    }));
  }
  const read = () => ({
    type: command.type,
    ...resolveUserProfileGitHubAttributionInDatabase(db, command.profileIds, command.host),
  });
  // Public attribution is one snapshot statement; Enterprise also reads verified bindings.
  return !command.host || command.host === "github.com"
    ? read()
    : runSqliteReadSnapshotSync(db, read);
}

/** Retain every account; the merge target owns primary choice and its coauthor consent. */
export function prepareUserProfileGitHubMerge(
  db: EngineConnection,
  sourceProfileIds: readonly string[],
  targetProfileId: string,
): void {
  const identities = selectStoredGitHubIdentities(db, [targetProfileId, ...sourceProfileIds]);
  const targetAccounts = identities.get(targetProfileId);
  const targetIdentity = targetAccounts?.primary;
  const survivingSourceProfileId = targetAccounts
    ? undefined
    : sourceProfileIds.find((profileId) => identities.get(profileId)?.primary);
  const survivingAccountId =
    targetIdentity?.accountId ??
    (survivingSourceProfileId
      ? identities.get(survivingSourceProfileId)?.primary?.accountId
      : undefined);
  const enterpriseIdentities = selectEnterpriseGitHubProfileIdsForMerge(db, sourceProfileIds);
  for (const sourceProfileId of sourceProfileIds) {
    const sourceIdentity = identities.get(sourceProfileId)?.primary;
    // Retained enterprise accounts keep consent even while merged bindings need fresh sign-in.
    if (
      !enterpriseIdentities.has(sourceProfileId) &&
      (!sourceIdentity || sourceIdentity.accountId !== survivingAccountId)
    ) {
      deleteUserPreference(db, sourceProfileId, GIT_COAUTHOR_PREFERENCE_KEY);
    }
  }
  executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .updateTable("user_profiles")
      .set({ primary_github_account_id: survivingAccountId ?? null })
      .where("id", "=", targetProfileId),
  );
}

type GitHubProfileAlias =
  | { kind: "email"; email: string }
  | { kind: "github-login"; subject: string };

function selectGitHubProfileAlias(db: EngineConnection, alias: GitHubProfileAlias) {
  return alias.kind === "email"
    ? selectUserProfileEmailAlias(db, alias.email)
    : executeSqliteQueryTakeFirstSync(
        db,
        userProfilesDb(db)
          .selectFrom("user_profile_identities")
          .select("profile_id")
          .where("provider", "=", GITHUB_PROVIDER)
          .where("subject", "=", alias.subject)
          .where("canonical_login", "is", null),
      );
}

function readGitHubIdentityBinding(
  db: EngineConnection,
  alias: GitHubProfileAlias,
  accountId: number,
) {
  const kysely = userProfilesDb(db);
  const subject = String(accountId);
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("user_profile_identities")
      .leftJoin("user_profiles", "user_profiles.id", "user_profile_identities.profile_id")
      .select(["profile_id", "canonical_login", "primary_github_account_id"])
      .where("provider", "=", GITHUB_PROVIDER)
      .where("subject", "=", subject)
      .where("canonical_login", "is not", null),
  );
  const aliasIdentity = selectGitHubProfileAlias(db, alias);
  const aliasProfileId = aliasIdentity
    ? selectResolvedUserProfileMetadataById(db, aliasIdentity.profile_id)?.id
    : undefined;
  const aliasGitHubIdentity = aliasProfileId
    ? selectStoredGitHubIdentities(db, [aliasProfileId]).get(aliasProfileId)
    : undefined;
  const existingProfileId = existing
    ? selectResolvedUserProfileMetadataById(db, existing.profile_id)?.id
    : undefined;
  return { existing, aliasIdentity, aliasProfileId, aliasGitHubIdentity, existingProfileId };
}

function assertCompatibleGitHubEmailBinding(
  binding: ReturnType<typeof readGitHubIdentityBinding>,
  accountId: number,
) {
  const { existingProfileId, aliasProfileId, aliasGitHubIdentity } = binding;
  if (
    [
      binding.aliasIdentity?.profile_id,
      binding.existing?.profile_id,
      aliasProfileId,
      existingProfileId,
    ].includes(GATEWAY_OWNER_PROFILE_ID)
  ) {
    throw new UserProfileOwnerError("merge");
  }
  if (
    (existingProfileId && existingProfileId !== aliasProfileId) ||
    (aliasGitHubIdentity &&
      !aliasGitHubIdentity.accounts.some((account) => account.accountId === accountId))
  ) {
    throw new Error(
      "GitHub identity requires explicit linking to this email; ask an administrator to use users.linkEmail",
    );
  }
}

/** The email owner checks the same conflicts even when optional GitHub metadata is unavailable. */
export function assertGitHubEmailIdentityBinding(
  db: EngineConnection,
  email: string,
  accountId: number,
) {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new TypeError("GitHub account id must be a positive safe integer");
  }
  assertCompatibleGitHubEmailBinding(
    readGitHubIdentityBinding(db, { kind: "email", email }, accountId),
    accountId,
  );
}

export function applyVerifiedGitHubIdentity(params: {
  db: EngineConnection;
  alias: GitHubProfileAlias;
  identity: { accountId: number; login: string };
  preserveEmailProfile?: boolean;
  createProfile: () => string;
  mergeProfiles: (sourceProfileId: string, targetProfileId: string) => void;
  mutation?: UserProfileMutationContext;
}): { profileId: string; changed: boolean } {
  if (!Number.isSafeInteger(params.identity.accountId) || params.identity.accountId <= 0) {
    throw new TypeError("GitHub account id must be a positive safe integer");
  }
  const login = normalizeGitHubLogin(params.identity.login);
  if (!login) {
    throw new TypeError("GitHub login is invalid");
  }
  const db = params.db;
  const kysely = userProfilesDb(db);
  const subject = String(params.identity.accountId);
  const now = Date.now();
  const bindingFacts = readGitHubIdentityBinding(db, params.alias, params.identity.accountId);
  const { existing, aliasIdentity, aliasProfileId, aliasGitHubIdentity, existingProfileId } =
    bindingFacts;
  if (params.preserveEmailProfile) {
    assertCompatibleGitHubEmailBinding(bindingFacts, params.identity.accountId);
  }
  const reusableAliasProfileId =
    aliasProfileId &&
    (aliasGitHubIdentity === undefined ||
      aliasGitHubIdentity.accounts.some(
        (account) => account.accountId === params.identity.accountId,
      ))
      ? aliasProfileId
      : undefined;
  const currentProfileId = reusableAliasProfileId ?? existingProfileId ?? params.createProfile();
  const targetProfileId = existingProfileId ?? currentProfileId;
  // An email linked by older code must not turn shared owner attribution into a person.
  if (
    aliasIdentity?.profile_id === GATEWAY_OWNER_PROFILE_ID ||
    existing?.profile_id === GATEWAY_OWNER_PROFILE_ID ||
    currentProfileId === GATEWAY_OWNER_PROFILE_ID ||
    targetProfileId === GATEWAY_OWNER_PROFILE_ID
  ) {
    throw new UserProfileOwnerError("merge");
  }
  const affectedProfileIds = [
    currentProfileId,
    targetProfileId,
    ...(aliasIdentity ? [aliasIdentity.profile_id] : []),
    ...(aliasProfileId ? [aliasProfileId] : []),
    ...(existing ? [existing.profile_id] : []),
  ];
  params.mutation?.before(db, ...affectedProfileIds);
  const currentIdentity =
    currentProfileId === aliasProfileId
      ? aliasGitHubIdentity
      : selectStoredGitHubIdentities(db, [currentProfileId]).get(currentProfileId);
  if (
    !params.preserveEmailProfile &&
    targetProfileId === currentProfileId &&
    !currentIdentity?.accounts.some((account) => account.accountId === params.identity.accountId)
  ) {
    deleteUserPreference(db, targetProfileId, GIT_COAUTHOR_PREFERENCE_KEY);
  }

  if (currentProfileId !== targetProfileId) {
    params.mergeProfiles(currentProfileId, targetProfileId);
  }
  const targetAccounts =
    currentProfileId === targetProfileId
      ? currentIdentity
      : selectStoredGitHubIdentities(db, [targetProfileId]).get(targetProfileId);
  // A secondary sign-in never selects public credit or repairs an ambiguous primary.
  const primaryAccountId =
    !targetAccounts || targetAccounts.primary
      ? (targetAccounts?.primary?.accountId ?? params.identity.accountId)
      : undefined;
  const authorityChanged =
    currentProfileId !== targetProfileId ||
    existing?.profile_id !== targetProfileId ||
    existing.canonical_login !== login ||
    aliasIdentity?.profile_id !== targetProfileId;
  if (
    !authorityChanged &&
    (primaryAccountId === undefined || existing.primary_github_account_id === primaryAccountId)
  ) {
    return { profileId: targetProfileId, changed: false };
  }
  if (primaryAccountId !== undefined) {
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("user_profiles")
        .set({
          primary_github_account_id: primaryAccountId,
        })
        .where("id", "=", targetProfileId),
    );
  }
  const writeIdentity = (identitySubject: string, canonicalLogin: string | null) => {
    const binding = { profile_id: targetProfileId, canonical_login: canonicalLogin };
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("user_profile_identities")
        .values({
          provider: GITHUB_PROVIDER,
          subject: identitySubject,
          ...binding,
          created_at: now,
        })
        .onConflict((conflict) => conflict.columns(["provider", "subject"]).doUpdateSet(binding)),
    );
  };
  writeIdentity(subject, login);
  if (params.alias.kind === "email") {
    setUserProfileEmailBinding(db, params.alias.email, targetProfileId, now);
  } else {
    writeIdentity(params.alias.subject, null);
  }
  if (authorityChanged) {
    params.mutation?.authority(...affectedProfileIds);
    publishUserProfileAuthorityChange(db, ...affectedProfileIds);
  }
  return { profileId: targetProfileId, changed: true };
}
