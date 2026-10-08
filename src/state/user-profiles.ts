import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sql } from "kysely";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  ensureProfileForEmailInDatabase,
  normalizeProfileEmail as normalizeEmail,
} from "./user-profile-email.kernel.js";
import { publishUserProfileAuthorityChange } from "./user-profile-events.js";
import {
  assertGitHubEmailIdentityBinding,
  githubAuthenticationSubject,
} from "./user-profile-github-identity.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import {
  runUserProfileWriteTransaction,
  type UserProfileMutationOptions,
} from "./user-profile-mutation.js";
import {
  insertUserProfile,
  requireResolvedUserProfileMetadataById,
  selectUserProfileEmailAlias,
  selectResolvedUserProfileMetadataById,
  toUserProfile,
  userProfilesDb,
} from "./user-profiles-internal.js";
import {
  ensureGatewayOwnerProfileRow,
  readGatewayOwnerProfileForEnsure,
} from "./user-profiles-owner.js";
import {
  ensureUserProfileRoleSchema,
  ensureUserProfilesSchema,
  UserProfileNotFoundError,
} from "./user-profiles-schema.js";
import {
  classifyTailscaleLogin,
  type TailscaleProfileIdentity,
} from "./user-profiles-tailscale-login.js";
import { MAX_USER_PROFILE_DISPLAY_NAME_LENGTH, type UserProfile } from "./user-profiles.types.js";

export { formatUserProfileAvatarEtag } from "./user-profiles-internal.js";
export {
  getUserProfileDisplay,
  readUserProfileAliases,
  hasMultipleSessionSharingIdentities,
} from "./user-profile-list.js";
export { listProfiles } from "./user-profile-reads.js";

export { adoptTailscaleProfileAvatar } from "./user-profiles-avatar.js";

export { UserProfileNotFoundError };

export function normalizeInitialDisplayName(name: string | null | undefined): string | null {
  const normalized = name?.trim();
  return normalized ? truncateUtf16Safe(normalized, MAX_USER_PROFILE_DISPLAY_NAME_LENGTH) : null;
}

/** Resolves a durable profile reference to its current one-hop merge head. */
export function resolveUserProfileId(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): string | undefined {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  return selectResolvedUserProfileMetadataById(db, profileId)?.id;
}

/** Reads the role assigned to an existing profile's current merge head. */
export function getUserProfileRole(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): string | null {
  ensureUserProfileRoleSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  return requireResolvedUserProfileMetadataById(db, profileId).role ?? null;
}

function ensureProfileForEmailWithInitialName(
  email: string,
  initialDisplayName: string | null,
  options: UserProfileMutationOptions & { expectedGitHubAccountId?: number },
): UserProfile {
  const normalizedEmail = normalizeEmail(email);
  ensureUserProfilesSchema(options);
  const { db: reader } = openOpenClawStateDatabase(options);
  const assertBinding = (database: DatabaseSync) => {
    if (options.expectedGitHubAccountId !== undefined) {
      assertGitHubEmailIdentityBinding(database, normalizedEmail, options.expectedGitHubAccountId);
    }
  };
  const selectExistingProfile = (database: DatabaseSync) => {
    assertBinding(database);
    const alias = selectUserProfileEmailAlias(database, normalizedEmail);
    return alias
      ? toUserProfile(requireResolvedUserProfileMetadataById(database, alias.profile_id))
      : undefined;
  };
  // Keep alias and merge-head reads coherent without taking writer admission.
  const found = runSqliteDeferredTransactionSync(reader, () => selectExistingProfile(reader));
  if (found) {
    return found;
  }
  const now = Date.now();
  return runUserProfileWriteTransaction(
    ({ db }) => {
      assertBinding(db);
      return ensureProfileForEmailInDatabase(
        db,
        normalizedEmail,
        initialDisplayName,
        now,
        options.mutation,
      );
    },
    options,
    { operationLabel: "user-profiles.ensure" },
  );
}

/** Resolves an email alias or atomically creates its first durable profile. */
export function ensureProfileForEmail(
  email: string,
  options: UserProfileMutationOptions & { expectedGitHubAccountId?: number } = {},
): UserProfile {
  return ensureProfileForEmailWithInitialName(email, null, options);
}

function ensureProfileForProviderIdentity(params: {
  provider: string;
  subject: string;
  initialDisplayName: string | null;
  options: UserProfileMutationOptions;
}): UserProfile {
  const options = params.options;
  const subject =
    params.provider === "github" ? githubAuthenticationSubject(params.subject) : params.subject;
  ensureUserProfilesSchema(params.options);
  const { db: reader } = openOpenClawStateDatabase(params.options);
  const selectExistingIdentity = (database: DatabaseSync) => {
    let query = userProfilesDb(database)
      .selectFrom("user_profile_identities")
      .select(["profile_id", "subject"])
      .where("provider", "=", params.provider);
    query =
      params.provider === "github"
        ? query
            .where((eb) =>
              eb.or([
                eb("subject", "=", subject),
                eb.and([eb("subject", "=", params.subject), eb("canonical_login", "is", null)]),
              ]),
            )
            .orderBy(sql`CASE WHEN subject = ${subject} THEN 0 ELSE 1 END`)
        : query.where("subject", "=", subject);
    return executeSqliteQueryTakeFirstSync(database, query);
  };
  const existing = runSqliteDeferredTransactionSync(reader, () => {
    const identity = selectExistingIdentity(reader);
    return identity?.subject === subject
      ? toUserProfile(requireResolvedUserProfileMetadataById(reader, identity.profile_id))
      : undefined;
  });
  if (existing) {
    return existing;
  }
  const now = Date.now();
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      const existingIdentity = selectExistingIdentity(db);
      if (existingIdentity) {
        const profile = requireResolvedUserProfileMetadataById(db, existingIdentity.profile_id);
        if (existingIdentity.subject !== subject) {
          options.mutation?.before(db, existingIdentity.profile_id);
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("user_profile_identities")
              .set({ subject })
              .where("provider", "=", params.provider)
              .where("subject", "=", existingIdentity.subject),
          );
          options.mutation?.authority(existingIdentity.profile_id, profile.id);
          publishUserProfileAuthorityChange(db, existingIdentity.profile_id, profile.id);
          options.mutation?.publish(existingIdentity.profile_id);
          publishUserProfilesChange(db, existingIdentity.profile_id);
        }
        return toUserProfile(profile);
      }
      const row = insertUserProfile(db, params.initialDisplayName, now, options.mutation);
      executeSqliteQuerySync(
        db,
        kysely.insertInto("user_profile_identities").values({
          provider: params.provider,
          subject,
          profile_id: row.id,
          canonical_login: null,
          created_at: now,
        }),
      );
      options.mutation?.authority(row.id);
      options.mutation?.publish(row.id);
      publishUserProfilesChange(db, row.id);
      return toUserProfile(row);
    },
    params.options,
    { operationLabel: "user-profiles.ensure-identity" },
  );
}

function adoptDisplayNameIfEmpty(
  profileId: string,
  displayName: string | null,
  options: UserProfileMutationOptions,
): UserProfile {
  const { db: reader } = openOpenClawStateDatabase(options);
  const existing = runSqliteDeferredTransactionSync(reader, () =>
    requireResolvedUserProfileMetadataById(reader, profileId),
  );
  if (!displayName || existing.display_name?.trim()) {
    return toUserProfile(existing);
  }
  const now = Date.now();
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileMetadataById(db, profileId);
      options.mutation?.before(db, profile.id);
      if (profile.display_name?.trim()) {
        return toUserProfile(profile);
      }
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ display_name: displayName, updated_at: now })
          .where("id", "=", profile.id),
      );
      options.mutation?.publish(profile.id);
      publishUserProfilesChange(db, profile.id);
      return toUserProfile({ ...profile, display_name: displayName, updated_at: now });
    },
    options,
    { operationLabel: "user-profiles.adopt-display-name" },
  );
}

/** Shared-secret devices resolve one local owner without inventing an email identity. */
export function ensureGatewayOwnerProfile(
  initialDisplayName: string | null,
  options: UserProfileMutationOptions = {},
): UserProfile {
  const displayName = normalizeInitialDisplayName(initialDisplayName);
  ensureUserProfilesSchema(options);
  const { db: reader } = openOpenClawStateDatabase(options);
  const found = runSqliteDeferredTransactionSync(reader, () => {
    const { existing, identified } = readGatewayOwnerProfileForEnsure(reader);
    return existing && identified && (!displayName || existing.display_name?.trim())
      ? existing
      : undefined;
  });
  if (found) {
    return toUserProfile(found);
  }
  return runUserProfileWriteTransaction(
    ({ db }) => toUserProfile(ensureGatewayOwnerProfileRow(db, displayName, options.mutation)),
    options,
    { operationLabel: "user-profiles.ensure-owner" },
  );
}

/** Resolves a verified Tailscale login and adopts its display name into an empty field. */
export function ensureProfileForTailscaleIdentity(
  identity: TailscaleProfileIdentity,
  options: UserProfileMutationOptions = {},
): UserProfile {
  const classified = classifyTailscaleLogin(identity.login);
  if (classified.kind === "invalid") {
    throw new TypeError("Tailscale login must contain a nonempty subject and suffix");
  }
  const displayName = normalizeInitialDisplayName(identity.name);
  const resolved =
    classified.kind === "email"
      ? ensureProfileForEmailWithInitialName(classified.email, displayName, options)
      : ensureProfileForProviderIdentity({
          provider: classified.provider,
          subject: classified.subject,
          initialDisplayName: displayName,
          options,
        });
  return adoptDisplayNameIfEmpty(resolved.id, displayName, options);
}
