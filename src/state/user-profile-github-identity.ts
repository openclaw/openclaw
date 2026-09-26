import type { DatabaseSync } from "node:sqlite";
import {
  GATEWAY_OWNER_PROFILE_ID,
  GIT_COAUTHOR_PREFERENCE_KEY,
  isGitCoauthorCreditEnabled,
} from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { UserProfileGitHubIdentity } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import type { OpenClawStateReadCommand } from "./openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { deleteUserPreference, selectUserPreferenceValues } from "./user-preferences.store.js";
import {
  captureUserProfileAuthorityRead,
  publishUserProfileAuthorityChange,
} from "./user-profile-events.js";
import type { UserProfileMutationContext } from "./user-profile-mutation.js";
import {
  selectResolvedUserProfileMetadataById,
  setUserProfileEmailBinding,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { UserProfileOwnerError } from "./user-profiles-schema.js";
import type {
  CachedGitHubIdentity,
  StoredGitHubIdentity,
  UserProfileGitHubAttribution,
  UserProfileGitHubAttributionRead,
} from "./user-profiles.types.js";

const GITHUB_PROVIDER = "github";
const GITHUB_LOGIN_SUBJECT_PREFIX = "login:";
const githubColumnFacts = new WeakMap<
  SqliteSchemaFacts,
  { primaryAccount: boolean; verifiedLogin: boolean }
>();

function readGitHubColumns(db: DatabaseSync) {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (!schema) {
    return {
      primaryAccount: tableHasColumn(db, "user_profiles", "primary_github_account_id"),
      verifiedLogin: tableHasColumn(db, "user_profile_identities", "canonical_login"),
    };
  }
  let columns = githubColumnFacts.get(schema);
  if (!columns) {
    const hasColumn = (table: "user_profiles" | "user_profile_identities", column: string) => {
      const sql = schema.tableSql.get(table);
      return sql !== undefined && parseSqliteTableDefinition(sql, table).columns.has(column);
    };
    columns = {
      primaryAccount: hasColumn("user_profiles", "primary_github_account_id"),
      verifiedLogin: hasColumn("user_profile_identities", "canonical_login"),
    };
    githubColumnFacts.set(schema, columns);
  }
  return columns;
}

function parseStoredGitHubIdentity(row: {
  subject: string | null | undefined;
  canonical_login: string | null | undefined;
}): StoredGitHubIdentity | null {
  const accountId = Number(row.subject);
  const login = row.canonical_login ? normalizeGitHubLogin(row.canonical_login) : undefined;
  return login && Number.isSafeInteger(accountId) && accountId > 0 ? { accountId, login } : null;
}

function toPublicGitHubIdentity(identity: StoredGitHubIdentity): UserProfileGitHubIdentity {
  return {
    login: identity.login,
    profileUrl: `https://github.com/${identity.login}`,
    avatarUrl: `https://avatars.githubusercontent.com/u/${identity.accountId}?v=4`,
  };
}

export function selectStoredGitHubIdentities(
  db: DatabaseSync,
  profileIds?: readonly string[],
): Map<string, { accounts: StoredGitHubIdentity[]; primary: StoredGitHubIdentity | undefined }> {
  if (profileIds?.length === 0) {
    return new Map();
  }
  const columns = readGitHubColumns(db);
  if (!columns.verifiedLogin) {
    return new Map();
  }
  let query = userProfilesDb(db)
    .selectFrom("user_profile_identities")
    .innerJoin("user_profiles", "user_profiles.id", "user_profile_identities.profile_id")
    .select(["profile_id", "subject", "canonical_login"])
    // Read-only catalog projections must not initialize a pre-feature database.
    .select((eb) => [
      columns.primaryAccount
        ? "user_profiles.primary_github_account_id"
        : eb.val<number | null>(null).as("primary_github_account_id"),
    ])
    .where("provider", "=", GITHUB_PROVIDER)
    .where("canonical_login", "is not", null)
    .orderBy("subject", "asc");
  if (profileIds) {
    query = query.where("profile_id", "in", [...profileIds]);
  }
  const rows = executeSqliteQuerySync(db, query).rows;
  const profiles = new Map<
    string,
    { accounts: StoredGitHubIdentity[]; primaryId: number | null }
  >();
  for (const row of rows) {
    const identity = parseStoredGitHubIdentity(row);
    if (!identity) {
      continue;
    }
    const profile = profiles.get(row.profile_id) ?? {
      accounts: [],
      primaryId: row.primary_github_account_id ?? null,
    };
    profile.accounts.push(identity);
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

function resolveCachedGitHubIdentityInDatabase(
  db: DatabaseSync,
  params: { accountId: number; email: string },
): CachedGitHubIdentity | undefined {
  const email = params.email.trim().toLowerCase();
  if (
    !email ||
    !Number.isSafeInteger(params.accountId) ||
    params.accountId <= 0 ||
    !tableExists(db, "user_profiles") ||
    !tableExists(db, "user_profile_emails") ||
    !tableExists(db, "user_profile_identities") ||
    !readGitHubColumns(db).verifiedLogin
  ) {
    return undefined;
  }
  const alias = executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_emails")
      .select("profile_id")
      .where("email", "=", email),
  );
  const profile = alias ? selectResolvedUserProfileMetadataById(db, alias.profile_id) : undefined;
  if (!profile) {
    return undefined;
  }
  const identity = selectStoredGitHubIdentities(db, [profile.id]).get(profile.id);
  return identity?.accounts.some((account) => account.accountId === params.accountId)
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
  db: DatabaseSync,
  profileIds?: readonly string[],
): Map<string, UserProfileGitHubIdentity> {
  return new Map(
    [...selectStoredGitHubIdentities(db, profileIds)].flatMap(([profileId, { primary }]) =>
      primary ? [[profileId, toPublicGitHubIdentity(primary)] as const] : [],
    ),
  );
}

/** Resolves current verified identities and public-credit preferences without initializing storage. */
export async function resolveUserProfileGitHubAttribution(
  profileIds: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): Promise<UserProfileGitHubAttribution> {
  if (profileIds.length === 0) {
    return new Map();
  }
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "userProfiles.githubAttribution.resolve", profileIds },
    { current: true },
  );
  if (!reply) {
    return new Map();
  }
  if (!reply.ok || reply.type !== "userProfiles.githubAttribution.resolve") {
    throw new Error("GitHub attribution reader returned an unexpected result");
  }
  return reply.identities;
}

function resolveUserProfileGitHubAttributionInDatabase(
  db: DatabaseSync,
  profileIds: readonly string[],
): UserProfileGitHubAttributionRead {
  if (profileIds.length === 0 || !tableExists(db, "user_profiles")) {
    return { identities: new Map(), canonicalProfileIds: [] };
  }
  const profiles = executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profiles")
      .select(["id", "merged_into"])
      .where("id", "in", [...profileIds]),
  ).rows;
  const canonicalBySource = new Map(
    profiles.map((profile) => [profile.id, profile.merged_into ?? profile.id] as const),
  );
  const canonicalIds = [...new Set(canonicalBySource.values())];
  const identities: ReturnType<typeof selectStoredGitHubIdentities> = tableExists(
    db,
    "user_profile_identities",
  )
    ? selectStoredGitHubIdentities(db, canonicalIds)
    : new Map();
  const preferences = selectUserPreferenceValues(db, canonicalIds, GIT_COAUTHOR_PREFERENCE_KEY);
  return {
    identities: new Map(
      [...canonicalBySource].map(([sourceId, canonicalId]) => [
        sourceId,
        isGitCoauthorCreditEnabled(preferences.get(canonicalId))
          ? (identities.get(canonicalId)?.primary ?? null)
          : null,
      ]),
    ),
    canonicalProfileIds: canonicalIds,
  };
}

/** Bind public credit to its live profile owner before any later publication awaits. */
export async function prepareUserProfileGitHubAttribution(
  profileIds: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): Promise<{ identities: UserProfileGitHubAttribution; isCurrent: () => boolean }> {
  const selectedProfileIds = [...profileIds];
  const context = captureOpenClawStateWorkerContext(options);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const authority = await captureUserProfileAuthorityRead(context.admission);
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "userProfiles.githubAttribution.resolve", profileIds: selectedProfileIds },
      { context, current: true },
    );
    context.admission.assertCurrent();
    if (reply && (!reply.ok || reply.type !== "userProfiles.githubAttribution.resolve")) {
      throw new Error("GitHub attribution reader returned an unexpected result");
    }
    const isCurrent = authority.bind([
      ...selectedProfileIds,
      ...(reply?.canonicalProfileIds ?? []),
    ]);
    if (isCurrent) {
      return { identities: reply?.identities ?? new Map(), isCurrent };
    }
  }
  throw new Error("Git co-author credit changed while preparing attribution");
}

export function readUserProfileGitHubCommand(
  db: DatabaseSync,
  command: Extract<
    OpenClawStateReadCommand,
    { type: "userProfiles.githubIdentity.cached" | "userProfiles.githubAttribution.resolve" }
  >,
):
  | { type: "userProfiles.githubIdentity.cached"; identity: CachedGitHubIdentity | undefined }
  | ({ type: "userProfiles.githubAttribution.resolve" } & UserProfileGitHubAttributionRead) {
  return runSqliteDeferredTransactionSync(db, () =>
    command.type === "userProfiles.githubIdentity.cached"
      ? {
          type: command.type,
          identity: resolveCachedGitHubIdentityInDatabase(db, command),
        }
      : {
          type: command.type,
          ...resolveUserProfileGitHubAttributionInDatabase(db, command.profileIds),
        },
  );
}

/** Retain every account; the merge target owns primary choice and its coauthor consent. */
export function prepareUserProfileGitHubMerge(
  db: DatabaseSync,
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
  for (const sourceProfileId of sourceProfileIds) {
    const sourceIdentity = identities.get(sourceProfileId)?.primary;
    if (!sourceIdentity || sourceIdentity.accountId !== survivingAccountId) {
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

export function applyVerifiedGitHubIdentity(params: {
  db: DatabaseSync;
  alias: { kind: "email"; email: string } | { kind: "github-login"; subject: string };
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
  const aliasIdentity =
    params.alias.kind === "email"
      ? executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("user_profile_emails")
            .select("profile_id")
            .where("email", "=", params.alias.email),
        )
      : executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("user_profile_identities")
            .select("profile_id")
            .where("provider", "=", GITHUB_PROVIDER)
            .where("subject", "=", params.alias.subject)
            .where("canonical_login", "is", null),
        );
  const aliasProfileId = aliasIdentity
    ? selectResolvedUserProfileMetadataById(db, aliasIdentity.profile_id)?.id
    : undefined;
  const aliasGitHubIdentity = aliasProfileId
    ? selectStoredGitHubIdentities(db, [aliasProfileId]).get(aliasProfileId)
    : undefined;
  const existingProfileId = existing
    ? selectResolvedUserProfileMetadataById(db, existing.profile_id)?.id
    : undefined;
  if (
    params.preserveEmailProfile &&
    ((existingProfileId && existingProfileId !== aliasProfileId) ||
      (aliasGitHubIdentity &&
        !aliasGitHubIdentity.accounts.some(
          (account) => account.accountId === params.identity.accountId,
        )))
  ) {
    throw new Error(
      "GitHub identity requires explicit linking to this email; ask an administrator to use users.linkEmail",
    );
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
  params.mutation?.before(
    db,
    currentProfileId,
    targetProfileId,
    ...(aliasIdentity ? [aliasIdentity.profile_id] : []),
    ...(aliasProfileId ? [aliasProfileId] : []),
    ...(existing ? [existing.profile_id] : []),
  );
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
    currentProfileId === targetProfileId &&
    existing?.profile_id === targetProfileId &&
    existing.canonical_login === login &&
    aliasIdentity?.profile_id === targetProfileId &&
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
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("user_profile_identities")
      .values({
        provider: GITHUB_PROVIDER,
        subject,
        profile_id: targetProfileId,
        canonical_login: login,
        created_at: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["provider", "subject"]).doUpdateSet({
          profile_id: targetProfileId,
          canonical_login: login,
        }),
      ),
  );
  if (params.alias.kind === "email") {
    setUserProfileEmailBinding(db, params.alias.email, targetProfileId, now);
  } else {
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("user_profile_identities")
        .values({
          provider: GITHUB_PROVIDER,
          subject: params.alias.subject,
          profile_id: targetProfileId,
          canonical_login: null,
          created_at: now,
        })
        .onConflict((conflict) =>
          conflict.columns(["provider", "subject"]).doUpdateSet({
            profile_id: targetProfileId,
            canonical_login: null,
          }),
        ),
    );
  }
  if (authorityChanged) {
    params.mutation?.authority(
      currentProfileId,
      targetProfileId,
      ...(aliasIdentity ? [aliasIdentity.profile_id] : []),
      ...(aliasProfileId ? [aliasProfileId] : []),
      ...(existing ? [existing.profile_id] : []),
    );
    publishUserProfileAuthorityChange(
      db,
      currentProfileId,
      targetProfileId,
      ...(aliasIdentity ? [aliasIdentity.profile_id] : []),
      ...(aliasProfileId ? [aliasProfileId] : []),
      ...(existing ? [existing.profile_id] : []),
    );
  }
  return { profileId: targetProfileId, changed: true };
}
