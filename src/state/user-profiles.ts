import { createHash } from "node:crypto";
// Durable user profiles plus typed login identities in the shared state DB.
import type { DatabaseSync } from "node:sqlite";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sql } from "kysely";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UserProfile as UserProfileListItem,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { ensureUserPreferencesSchema } from "./user-preferences.store.js";
import {
  applyVerifiedGitHubIdentity,
  githubAuthenticationSubject,
  selectUserProfileGitHubIdentities,
} from "./user-profile-github-identity.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import {
  requireResolvedUserProfileMetadataById,
  selectResolvedUserProfileMetadataById,
  toUserProfile,
  type UserProfile,
  type UserProfileRow,
  userProfileAvatarPresence,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { mergeUserProfiles } from "./user-profiles-merge.js";
import { ensureGatewayOwnerProfileRow } from "./user-profiles-owner.js";
import {
  ensureUserProfileRoleSchema,
  ensureUserProfilesSchema,
  hasEnsuredUserProfileRoleSchema,
  UserProfileNotFoundError,
  UserProfileOwnerError,
} from "./user-profiles-schema.js";
import {
  classifyTailscaleLogin,
  type TailscaleProfileIdentity,
} from "./user-profiles-tailscale-login.js";
import {
  MAX_USER_PROFILE_AVATAR_BYTES,
  USER_PROFILE_AVATAR_MIME_TYPES,
  type UserProfileAvatarMime,
} from "./user-profiles.types.js";

export { formatUserProfileAvatarEtag, getProfileAvatar } from "./user-profiles-internal.js";
export {
  getUserProfileDisplay,
  readUserProfileAliases,
  hasMultipleSessionSharingIdentities,
} from "./user-profile-list.js";
export { listProfiles } from "./user-profile-reads.js";

export { adoptTailscaleProfileAvatar } from "./user-profiles-avatar.js";

type GitHubAuthenticationAlias =
  | { kind: "email"; email: string }
  | { kind: "github-login"; login: string };

type UserProfileAvatarError =
  | { code: "avatar_too_large"; maxBytes: number }
  | { code: "unsupported_avatar_mime"; mime: string };

export { UserProfileNotFoundError };

const MAX_USER_PROFILE_DISPLAY_NAME_LENGTH = 256;

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new TypeError("email must not be empty");
  }
  return normalized;
}

function normalizeInitialDisplayName(name: string | null | undefined): string | null {
  const normalized = name?.trim();
  return normalized ? truncateUtf16Safe(normalized, MAX_USER_PROFILE_DISPLAY_NAME_LENGTH) : null;
}

function insertUserProfile(
  db: DatabaseSync,
  displayName: string | null,
  now: number,
): UserProfileRow {
  const row: UserProfileRow = {
    id: generateSecureUuid(),
    display_name: displayName,
    avatar: null,
    avatar_mime: null,
    avatar_sha256: null,
    merged_into: null,
    created_at: now,
    updated_at: now,
  };
  executeSqliteQuerySync(db, userProfilesDb(db).insertInto("user_profiles").values(row));
  return row;
}

function selectUserProfileListItemById(db: DatabaseSync, profileId: string): UserProfileListItem {
  const kysely = userProfilesDb(db);
  const profile = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("user_profiles")
      .select([
        "id",
        "display_name",
        "avatar_mime",
        "merged_into",
        ...(hasEnsuredUserProfileRoleSchema(db) ? (["role"] as const) : []),
        "created_at",
        "updated_at",
        userProfileAvatarPresence,
      ])
      .where("id", "=", profileId),
  );
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  const emails = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("user_profile_emails")
      .select("email")
      .where("profile_id", "=", profileId)
      .orderBy("email", "asc"),
  ).rows;
  return {
    ...toUserProfile(profile),
    emails: emails.map((alias) => alias.email),
    githubIdentity: selectUserProfileGitHubIdentities(db, [profileId]).get(profileId) ?? null,
    hasAvatar: profile.has_avatar === 1,
  };
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

/** Reads a profile's protocol-facing representation through its merge head. */
export function getUserProfileListItem(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileListItem {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const profile = requireResolvedUserProfileMetadataById(db, profileId);
  return selectUserProfileListItemById(db, profile.id);
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

/** Assigns or clears the role on an existing profile's current merge head. */
export function setUserProfileRole(
  profileId: string,
  role: string | null,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileListItem {
  ensureUserProfileRoleSchema(options);
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileMetadataById(db, profileId);
      if (profileId === GATEWAY_OWNER_PROFILE_ID || profile.id === GATEWAY_OWNER_PROFILE_ID) {
        throw new UserProfileOwnerError("role");
      }
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ role, updated_at: now })
          .where("id", "=", profile.id),
      );
      publishUserProfilesChange(db, profile.id);
      return selectUserProfileListItemById(db, profile.id);
    },
    options,
    { operationLabel: "user-profiles.set-role" },
  );
}

function ensureProfileForEmailWithInitialName(
  email: string,
  initialDisplayName: string | null,
  options: OpenClawStateDatabaseOptions,
): UserProfile {
  const normalizedEmail = normalizeEmail(email);
  const now = Date.now();
  const displayName =
    initialDisplayName ??
    truncateUtf16Safe(
      normalizedEmail.split("@", 1)[0] || normalizedEmail,
      MAX_USER_PROFILE_DISPLAY_NAME_LENGTH,
    );
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      const existingAlias = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select("profile_id")
          .where("email", "=", normalizedEmail),
      );
      if (existingAlias) {
        // Authenticated avatar reads reuse this path; unchanged identities must not refresh rosters.
        return toUserProfile(requireResolvedUserProfileMetadataById(db, existingAlias.profile_id));
      }
      const row = insertUserProfile(db, displayName, now);
      executeSqliteQuerySync(
        db,
        kysely.insertInto("user_profile_emails").values({
          email: normalizedEmail,
          profile_id: row.id,
          created_at: now,
        }),
      );
      publishUserProfilesChange(db, row.id);
      return toUserProfile(row);
    },
    options,
    { operationLabel: "user-profiles.ensure" },
  );
}

/** Resolves an email alias or atomically creates its first durable profile. */
export function ensureProfileForEmail(
  email: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfile {
  return ensureProfileForEmailWithInitialName(email, null, options);
}

function ensureProfileForProviderIdentity(params: {
  provider: string;
  subject: string;
  initialDisplayName: string | null;
  options: OpenClawStateDatabaseOptions;
}): UserProfile {
  const now = Date.now();
  const subject =
    params.provider === "github" ? githubAuthenticationSubject(params.subject) : params.subject;
  ensureUserProfilesSchema(params.options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      let existingQuery = kysely
        .selectFrom("user_profile_identities")
        .select(["profile_id", "subject"])
        .where("provider", "=", params.provider);
      existingQuery =
        params.provider === "github"
          ? existingQuery
              .where((eb) =>
                eb.or([
                  eb("subject", "=", subject),
                  eb.and([eb("subject", "=", params.subject), eb("canonical_login", "is", null)]),
                ]),
              )
              .orderBy(sql`CASE WHEN subject = ${subject} THEN 0 ELSE 1 END`)
          : existingQuery.where("subject", "=", subject);
      const existingIdentity = executeSqliteQueryTakeFirstSync(db, existingQuery);
      if (existingIdentity) {
        if (existingIdentity.subject !== subject) {
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("user_profile_identities")
              .set({ subject })
              .where("provider", "=", params.provider)
              .where("subject", "=", existingIdentity.subject),
          );
          publishUserProfilesChange(db, existingIdentity.profile_id);
        }
        return toUserProfile(
          requireResolvedUserProfileMetadataById(db, existingIdentity.profile_id),
        );
      }
      const row = insertUserProfile(db, params.initialDisplayName, now);
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
  options: OpenClawStateDatabaseOptions,
): UserProfile {
  if (!displayName) {
    const { db } = openOpenClawStateDatabase(options);
    return toUserProfile(requireResolvedUserProfileMetadataById(db, profileId));
  }
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileMetadataById(db, profileId);
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
  options: OpenClawStateDatabaseOptions = {},
): UserProfile {
  const displayName = normalizeInitialDisplayName(initialDisplayName);
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => toUserProfile(ensureGatewayOwnerProfileRow(db, displayName)),
    options,
    { operationLabel: "user-profiles.ensure-owner" },
  );
}

/** Resolves a verified Tailscale login and adopts its display name into an empty field. */
export function ensureProfileForTailscaleIdentity(
  identity: TailscaleProfileIdentity,
  options: OpenClawStateDatabaseOptions = {},
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

/** Links an email to a profile and retains an aliasless prior profile as a merge tombstone. */
export function linkEmail(
  email: string,
  targetProfileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileListItem {
  const normalizedEmail = normalizeEmail(email);
  const now = Date.now();
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      const target = requireResolvedUserProfileMetadataById(db, targetProfileId);
      if (targetProfileId === GATEWAY_OWNER_PROFILE_ID || target.id === GATEWAY_OWNER_PROFILE_ID) {
        throw new UserProfileOwnerError("merge");
      }
      const existingAlias = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select("profile_id")
          .where("email", "=", normalizedEmail),
      );
      if (existingAlias?.profile_id === GATEWAY_OWNER_PROFILE_ID) {
        throw new UserProfileOwnerError("merge");
      }
      if (!existingAlias) {
        executeSqliteQuerySync(
          db,
          kysely.insertInto("user_profile_emails").values({
            email: normalizedEmail,
            profile_id: target.id,
            created_at: now,
          }),
        );
        executeSqliteQuerySync(
          db,
          kysely.updateTable("user_profiles").set({ updated_at: now }).where("id", "=", target.id),
        );
        publishUserProfilesChange(db, target.id);
        return selectUserProfileListItemById(db, target.id);
      }
      if (existingAlias.profile_id === target.id) {
        return selectUserProfileListItemById(db, target.id);
      }
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("user_profile_emails")
          .set({ profile_id: target.id })
          .where("email", "=", normalizedEmail),
      );
      const remainingAliases = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select("email")
          .where("profile_id", "=", existingAlias.profile_id),
      ).rows;
      executeSqliteQuerySync(
        db,
        kysely.updateTable("user_profiles").set({ updated_at: now }).where("id", "=", target.id),
      );
      if (remainingAliases.length === 0) {
        mergeUserProfiles(db, existingAlias.profile_id, target.id, now);
      } else {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("user_profiles")
            .set({ updated_at: now })
            .where("id", "=", existingAlias.profile_id),
        );
      }
      publishUserProfilesChange(db, target.id, existingAlias.profile_id);
      return selectUserProfileListItemById(db, target.id);
    },
    options,
    { operationLabel: "user-profiles.link-email" },
  );
}

export function setDisplayName(
  profileId: string,
  name: string | null,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileListItem {
  const now = Date.now();
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileMetadataById(db, profileId);
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ display_name: name, updated_at: now })
          .where("id", "=", profile.id),
      );
      publishUserProfilesChange(db, profile.id);
      return selectUserProfileListItemById(db, profile.id);
    },
    options,
    { operationLabel: "user-profiles.set-display-name" },
  );
}

function normalizeGitHubAuthenticationAlias(
  alias: GitHubAuthenticationAlias,
): { kind: "email"; email: string } | { kind: "github-login"; subject: string } {
  return alias.kind === "email"
    ? { kind: "email", email: normalizeEmail(alias.email) }
    : { kind: "github-login", subject: githubAuthenticationSubject(alias.login) };
}

export function syncGitHubIdentity(
  params: {
    identity: { accountId: number; login: string; name?: string };
    authenticationAlias: GitHubAuthenticationAlias;
    initialDisplayName?: string;
  },
  options: OpenClawStateDatabaseOptions = {},
): UserProfileListItem {
  const alias = normalizeGitHubAuthenticationAlias(params.authenticationAlias);
  const githubDisplayName = normalizeInitialDisplayName(params.identity.name);
  const initialDisplayName =
    githubDisplayName ?? normalizeInitialDisplayName(params.initialDisplayName);
  ensureUserProfilesSchema(options);
  ensureUserPreferencesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const now = Date.now();
      const binding = applyVerifiedGitHubIdentity({
        db,
        alias,
        identity: params.identity,
        createProfile: () => insertUserProfile(db, initialDisplayName, now).id,
        mergeProfiles: (sourceProfileId, targetProfileId) =>
          mergeUserProfiles(db, sourceProfileId, targetProfileId, now),
      });
      const profile = selectUserProfileListItemById(db, binding.profileId);
      // Only the exact current GitHub login may be upgraded; preserve every other saved name.
      // Read the merge head inside this transaction so edits during lookup remain authoritative.
      const displayName =
        githubDisplayName && profile.displayName === params.identity.login.trim()
          ? githubDisplayName
          : (profile.displayName ?? initialDisplayName);
      if (!binding.changed && displayName === profile.displayName) {
        return profile;
      }
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ display_name: displayName, updated_at: now })
          .where("id", "=", profile.id),
      );
      publishUserProfilesChange(db, profile.id);
      return { ...profile, displayName, updatedAt: now };
    },
    options,
    { operationLabel: "user-profiles.sync-github-identity" },
  );
}

/** Stores a bounded, allowlisted avatar without ever leaving the write transaction async. */
export function setAvatar(
  profileId: string,
  bytes: Uint8Array,
  mime: string,
  options: OpenClawStateDatabaseOptions = {},
): Result<UserProfileListItem, UserProfileAvatarError> {
  if (bytes.byteLength > MAX_USER_PROFILE_AVATAR_BYTES) {
    return err({ code: "avatar_too_large", maxBytes: MAX_USER_PROFILE_AVATAR_BYTES });
  }
  if (!USER_PROFILE_AVATAR_MIME_TYPES.includes(mime as UserProfileAvatarMime)) {
    return err({ code: "unsupported_avatar_mime", mime });
  }
  const now = Date.now();
  ensureUserProfilesSchema(options);
  const value = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileMetadataById(db, profileId);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ avatar: bytes, avatar_mime: mime, avatar_sha256: sha256, updated_at: now })
          .where("id", "=", profile.id),
      );
      publishUserProfilesChange(db, profile.id);
      return selectUserProfileListItemById(db, profile.id);
    },
    options,
    { operationLabel: "user-profiles.set-avatar" },
  );
  return ok(value);
}
