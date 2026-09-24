import type { DatabaseSync } from "node:sqlite";
import { Check } from "typebox/value";
import {
  GATEWAY_OWNER_PROFILE_ID,
  UserChannelIdentitySchema,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  publishUserProfileAliasChange,
  publishUserChannelIdentityAuthorityChange,
} from "./user-profile-events.js";
import { selectStoredGitHubIdentities } from "./user-profile-github-identity.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import {
  requireResolvedUserProfileMetadataById,
  selectResolvedUserProfileMetadataById,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema, UserProfileOwnerError } from "./user-profiles-schema.js";
import { classifyTailscaleLogin } from "./user-profiles-tailscale-login.js";
import type {
  UserChannelIdentity,
  UserChannelIdentityLink,
  UserChannelIdentityAuthorityFacts,
} from "./user-profiles.types.js";

// The dot keeps administrator-attested channel links outside Tailscale login namespaces.
const CHANNEL_IDENTITY_PROVIDER = "channel.identity";

export class UserChannelIdentityConflictError extends Error {
  constructor() {
    super("channel identity is linked to another profile; unlink it from that profile first");
    this.name = "UserChannelIdentityConflictError";
  }
}

export function userChannelIdentitySubject(identity: UserChannelIdentity): string {
  if (!Check(UserChannelIdentitySchema, identity)) {
    throw new TypeError("invalid channel identity");
  }
  return JSON.stringify([identity.channelId, identity.accountId, identity.senderId]);
}

function readIdentity(subject: string): UserChannelIdentity | undefined {
  let tuple: unknown;
  try {
    tuple = JSON.parse(subject);
  } catch {
    return undefined;
  }
  if (!Array.isArray(tuple) || tuple.length !== 3) {
    return undefined;
  }
  const identity = { channelId: tuple[0], accountId: tuple[1], senderId: tuple[2] };
  return Check(UserChannelIdentitySchema, identity) ? identity : undefined;
}

function selectLink(db: DatabaseSync, subject: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_identities")
      .select("profile_id")
      .where("provider", "=", CHANNEL_IDENTITY_PROVIDER)
      .where("subject", "=", subject),
  );
}

function requirePerson(db: DatabaseSync, profileId: string) {
  const profile = requireResolvedUserProfileMetadataById(db, profileId);
  if (profileId === GATEWAY_OWNER_PROFILE_ID || profile.id === GATEWAY_OWNER_PROFILE_ID) {
    throw new UserProfileOwnerError("merge");
  }
  return profile;
}

function publishIdentityChange(db: DatabaseSync, profileId: string, subject: string) {
  publishUserChannelIdentityAuthorityChange(db, subject);
  publishUserProfilesChange(db, profileId);
  deferSqlitePostCommitPublication(db, publishUserProfileAliasChange);
}

/** An administrator attests the remote account belongs to this existing person. */
export function linkUserChannelIdentity(
  profileId: string,
  identity: UserChannelIdentity,
  options: OpenClawStateDatabaseOptions & { beforeChange?: (db: DatabaseSync) => void } = {},
): UserChannelIdentityLink {
  const subject = userChannelIdentitySubject(identity);
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requirePerson(db, profileId);
      const existing = selectLink(db, subject);
      if (existing) {
        if (requirePerson(db, existing.profile_id).id !== profile.id) {
          throw new UserChannelIdentityConflictError();
        }
        return { profileId: profile.id, identity };
      }
      options.beforeChange?.(db);
      executeSqliteQuerySync(
        db,
        userProfilesDb(db).insertInto("user_profile_identities").values({
          provider: CHANNEL_IDENTITY_PROVIDER,
          subject,
          profile_id: profile.id,
          canonical_login: null,
          created_at: Date.now(),
        }),
      );
      publishIdentityChange(db, profile.id, subject);
      return { profileId: profile.id, identity };
    },
    options,
    { operationLabel: "user-profiles.link-channel-identity" },
  );
}

/** The expected person prevents a stale unlink from deleting another person's binding. */
export function unlinkUserChannelIdentity(
  profileId: string,
  identity: UserChannelIdentity,
  options: OpenClawStateDatabaseOptions & { beforeChange?: (db: DatabaseSync) => void } = {},
): boolean {
  const subject = userChannelIdentitySubject(identity);
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requirePerson(db, profileId);
      const existing = selectLink(db, subject);
      if (!existing) {
        return false;
      }
      if (requirePerson(db, existing.profile_id).id !== profile.id) {
        throw new UserChannelIdentityConflictError();
      }
      options.beforeChange?.(db);
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .deleteFrom("user_profile_identities")
          .where("provider", "=", CHANNEL_IDENTITY_PROVIDER)
          .where("subject", "=", subject),
      );
      publishIdentityChange(db, profile.id, subject);
      return true;
    },
    options,
    { operationLabel: "user-profiles.unlink-channel-identity" },
  );
}

function hasIdentityTables(db: DatabaseSync): boolean {
  return tableExists(db, "user_profiles") && tableExists(db, "user_profile_identities");
}

export function listUserChannelIdentitiesInDatabase(
  db: DatabaseSync,
  profileId: string,
): UserChannelIdentityLink[] {
  return runSqliteDeferredTransactionSync(db, () => {
    if (!hasIdentityTables(db)) {
      return [];
    }
    const profile = requirePerson(db, profileId);
    return executeSqliteQuerySync(
      db,
      userProfilesDb(db)
        .selectFrom("user_profile_identities")
        .select("subject")
        .where("provider", "=", CHANNEL_IDENTITY_PROVIDER)
        .where("profile_id", "=", profile.id)
        .orderBy("subject", "asc"),
    ).rows.flatMap(({ subject }) => {
      const identity = readIdentity(subject);
      return identity ? [{ profileId: profile.id, identity }] : [];
    });
  });
}

/** Reads the current person and login grant subjects; channel links never become login aliases. */
export function resolveUserChannelIdentityInDatabase(
  db: DatabaseSync,
  identity: UserChannelIdentity,
): UserChannelIdentityAuthorityFacts | undefined {
  const subject = userChannelIdentitySubject(identity);
  return runSqliteDeferredTransactionSync(db, () => {
    if (!hasIdentityTables(db)) {
      return undefined;
    }
    const link = selectLink(db, subject);
    const profile = link ? selectResolvedUserProfileMetadataById(db, link.profile_id) : undefined;
    if (!profile || profile.id === GATEWAY_OWNER_PROFILE_ID) {
      return undefined;
    }
    const kysely = userProfilesDb(db);
    const emails = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("user_profile_emails")
        .select("email")
        .where("profile_id", "=", profile.id)
        .orderBy("email", "asc"),
    ).rows.map(({ email }) => email);
    const loginEmails = emails.filter((email) => {
      const login = classifyTailscaleLogin(email);
      // Legacy email-shaped GitHub aliases must not revive a renamed login's grant.
      return login.kind !== "provider" || login.provider !== "github";
    });
    const providerLogins = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("user_profile_identities")
        .select(["provider", "subject"])
        .where("profile_id", "=", profile.id)
        .where("canonical_login", "is", null),
    )
      // Retired attribution rows are not authenticated provider-login aliases.
      .rows.filter(
        (row) =>
          row.provider !== "github" &&
          row.provider !== "github-attribution" &&
          !row.provider.includes("."),
      )
      .map((row) => `${row.subject}@${row.provider}`);
    const githubLogins =
      selectStoredGitHubIdentities(db, [profile.id])
        .get(profile.id)
        ?.accounts.map((account) => `${account.login.toLowerCase()}@github`) ?? [];
    return {
      profileId: profile.id,
      role: profile.role ?? null,
      emails,
      loginIdentities: [
        ...new Set([...loginEmails, ...providerLogins, ...githubLogins]),
      ].toSorted(),
    };
  });
}

export function resolveUserChannelIdentity(
  identity: UserChannelIdentity,
  options: OpenClawStateDatabaseOptions = {},
): UserChannelIdentityAuthorityFacts | undefined {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => resolveUserChannelIdentityInDatabase(db, identity),
    options,
  );
}
