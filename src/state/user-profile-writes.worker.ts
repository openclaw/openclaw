import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UsersMergeResult,
  type UserProfile as UserProfileListItem,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  MAX_USER_PROFILE_AVATAR_BYTES,
  USER_PROFILE_AVATAR_MIME_TYPES,
} from "../shared/avatar-limits.js";
import { CHANNEL_IDENTITY_PROVIDER } from "./user-channel-identities.js";
import type { UserGitHubConnectionCommit } from "./user-github-connections.types.js";
import { ensureUserPreferencesSchema } from "./user-preferences.store.js";
import { normalizeProfileEmail as normalizeEmail } from "./user-profile-email.kernel.js";
import { publishUserProfileAuthorityChange } from "./user-profile-events.js";
import {
  applyVerifiedGitHubIdentity,
  githubAuthenticationSubject,
  selectProfileAccessEntries,
  selectUserProfileGitHubIdentities,
} from "./user-profile-github-identity.js";
import { readUserProfileEmailBindings } from "./user-profile-identity.read.js";
import { projectUserProfileDisplay, publishUserProfilesChange } from "./user-profile-list.js";
import {
  runUserProfileWriteTransaction,
  type UserProfileMutationContext,
  type UserProfileMutationPublication,
  type UserProfileMutationOptions,
} from "./user-profile-mutation.js";
import {
  insertUserProfile,
  selectUserProfileEmailAlias,
  setUserProfileEmailBinding,
  requireResolvedUserProfileMetadataById,
  userProfilesDb,
  toUserProfile,
  selectUserProfileEmails,
  userProfileAvatarPresence,
} from "./user-profiles-internal.js";
import { mergeUserProfiles } from "./user-profiles-merge.js";
import {
  ensureUserProfileRoleSchema,
  ensureUserProfilesSchema,
  hasEnsuredUserProfileRoleSchema,
  UserProfileMergeError,
  UserProfileNotFoundError,
  UserProfileOwnerError,
} from "./user-profiles-schema.js";
import { normalizeInitialDisplayName } from "./user-profiles.js";
import type {
  ProfileDisplayRow,
  UserProfileEmailBinding,
  UserProfileDisplay,
} from "./user-profiles.types.js";
import type { WorkerOperationContext } from "./worker-operation-registry.js";

type GitHubAuthenticationAlias =
  | { kind: "email"; email: string }
  | { kind: "github-login"; login: string };

type UserProfileAvatarError =
  | { code: "avatar_too_large"; maxBytes: number }
  | { code: "unsupported_avatar_mime"; mime: string };

export type UserProfileWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "not-found"; profileId: string }
  | { ok: false; kind: "merge"; message: string }
  | { ok: false; kind: "owner"; code: UserProfileOwnerError["code"] };
type PendingPublication = {
  before: Map<string, ProfileDisplayRow | undefined>;
  emailBindings: Map<string, UserProfileEmailBinding>;
  display: Set<string>;
  profiles: Set<string>;
  identities: Set<string>;
  githubConnections: UserGitHubConnectionCommit;
};

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
  return {
    ...toUserProfile(profile),
    emails: selectUserProfileEmails(db, profileId),
    githubIdentity: selectUserProfileGitHubIdentities(db, [profileId]).get(profileId) ?? null,
    hasAvatar: profile.has_avatar === 1,
  };
}

export function createUserProfileWriteOperation<Input, Output>(
  type: string,
  write: (
    input: Input,
    owned: UserProfileMutationOptions,
    display: () => UserProfileDisplay,
  ) => Output,
  targetProfileId?: (input: Input) => string,
) {
  return (
    input: Input,
    { open, stateOptions }: WorkerOperationContext,
  ): UserProfileWriteResult<Output> => {
    const options = { ...stateOptions(), database: open() };
    const target = targetProfileId?.(input);
    let pending: PendingPublication | undefined;
    let sequence = 0;
    const committed: UserProfileMutationPublication[] = [];
    let linkedDisplay: ReturnType<typeof projectUserProfileDisplay> | undefined;
    const mutation: UserProfileMutationContext = {
      runTransaction(db, operation) {
        if (pending) {
          return operation();
        }
        const current: PendingPublication = {
          before: new Map(),
          emailBindings: new Map(),
          display: new Set(),
          profiles: new Set(),
          identities: new Set(),
          githubConnections: {
            kind: "user-github-connection",
            changedOwners: [],
            retiredProfileIds: [],
          },
        };
        pending = current;
        try {
          requestSqliteWorkerOperationAdmission({
            stage: "transaction",
            facts: { kind: "user-profile-write", operation: type },
          });
          const value = operation();
          if (target !== undefined) {
            const linked = requireResolvedUserProfileMetadataById(db, target);
            const row = selectProfileAccessEntries(db, [linked.id])[0]?.[1];
            if (!row) {
              throw new UserProfileNotFoundError(linked.id);
            }
            linkedDisplay = projectUserProfileDisplay(row);
          }
          const afterBindings = new Map(
            readUserProfileEmailBindings(db, [...current.before.keys()]).map((binding) => [
              binding.email,
              binding,
            ]),
          );
          const emailBindings = [
            ...new Set([...current.emailBindings.keys(), ...afterBindings.keys()]),
          ].flatMap((email) => {
            const before = current.emailBindings.get(email) ?? null;
            const after = afterBindings.get(email) ?? null;
            if (before?.profileId === after?.profileId && before?.bindingId === after?.bindingId) {
              return [];
            }
            for (const binding of [before, after]) {
              if (binding) {
                current.display.add(binding.profileId);
                current.profiles.add(binding.profileId);
              }
            }
            return [{ email, before, after }];
          });
          const ids = [...current.display];
          const after = new Map(ids.length ? selectProfileAccessEntries(db, ids) : []);
          const publication: UserProfileMutationPublication = {
            kind: "user-profile-mutation",
            sequence: ++sequence,
            changes: {
              profiles: [...current.profiles],
              identities: [...current.identities],
              channels: [],
            },
            before: ids.map((id) => {
              if (!current.before.has(id)) {
                throw new Error("Profile publication requires its transaction's original row");
              }
              return [id, current.before.get(id)];
            }),
            after: ids.map((id) => [id, after.get(id)]),
            emailBindings,
            ...(current.githubConnections.changedOwners.length ||
            current.githubConnections.retiredProfileIds.length
              ? { githubConnections: current.githubConnections }
              : {}),
          };
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: publication });
          deferSqlitePostCommitPublication(db, () => committed.push(publication));
          deferSqliteWorkerCommitReceipt(db, {
            kind: "user-profile-commits",
            publications: [...committed, publication],
          });
          return value;
        } finally {
          pending = undefined;
        }
      },
      before(db, ...ids) {
        const current = pending;
        if (!current) {
          throw new Error("Profile mutation requires its original transaction");
        }
        const missing = ids.filter((id) => !current.before.has(id));
        const rows = new Map(missing.length ? selectProfileAccessEntries(db, missing) : []);
        for (const id of missing) {
          current.before.set(id, rows.get(id));
        }
        for (const binding of readUserProfileEmailBindings(db, missing)) {
          if (!current.emailBindings.has(binding.email)) {
            current.emailBindings.set(binding.email, binding);
          }
        }
      },
      authority: (...ids) => ids.forEach((id) => pending?.profiles.add(id)),
      identity: (...ids) => ids.forEach((id) => pending?.identities.add(id)),
      publish: (...ids) => ids.forEach((id) => pending?.display.add(id)),
      publishGitHubConnections: (receipt) => {
        pending?.githubConnections.changedOwners.push(...receipt.changedOwners);
        pending?.githubConnections.retiredProfileIds.push(...receipt.retiredProfileIds);
      },
    };
    const owned = { ...options, mutation };
    try {
      return {
        ok: true,
        value: write(input, owned, () => {
          if (!linkedDisplay) {
            throw new Error("Profile mutation publication is unavailable");
          }
          return linkedDisplay;
        }),
      };
    } catch (error) {
      if (error instanceof UserProfileNotFoundError) {
        return { ok: false, kind: "not-found", profileId: error.profileId };
      }
      if (error instanceof UserProfileMergeError) {
        return { ok: false, kind: "merge", message: error.message };
      }
      if (error instanceof UserProfileOwnerError) {
        return { ok: false, kind: "owner", code: error.code };
      }
      throw error;
    }
  };
}

/** Assigns or clears the role on an existing profile's current merge head. */
export function setUserProfileRole(
  profileId: string,
  role: string | null,
  options: UserProfileMutationOptions = {},
): UserProfileListItem {
  ensureUserProfileRoleSchema(options);
  const now = Date.now();
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileMetadataById(db, profileId);
      options.mutation?.before(db, profile.id);
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
      if ((profile.role ?? null) !== role) {
        options.mutation?.authority(profile.id);
        publishUserProfileAuthorityChange(db, profile.id);
      }
      options.mutation?.publish(profile.id);
      publishUserProfilesChange(db, profile.id);
      return selectUserProfileListItemById(db, profile.id);
    },
    options,
    { operationLabel: "user-profiles.set-role" },
  );
}

/** Explicit administration keeps both selected IDs exact; only an exact repeat may follow a tombstone. */
export function mergeProfiles(
  sourceProfileId: string,
  targetProfileId: string,
  options: UserProfileMutationOptions = {},
): UsersMergeResult {
  ensureUserProfilesSchema(options);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const source = requireResolvedUserProfileMetadataById(db, sourceProfileId);
      const target = requireResolvedUserProfileMetadataById(db, targetProfileId);
      if (
        [sourceProfileId, targetProfileId, source.id, target.id].includes(GATEWAY_OWNER_PROFILE_ID)
      ) {
        throw new UserProfileOwnerError("merge");
      }
      if (sourceProfileId === targetProfileId) {
        throw new UserProfileMergeError("source and target profiles must differ");
      }
      if (target.id !== targetProfileId) {
        throw new UserProfileMergeError(
          `target profile ${targetProfileId} is merged into ${target.id}; choose the current merge head`,
        );
      }
      if (source.id !== sourceProfileId) {
        if (source.id === target.id) {
          return { profile: selectUserProfileListItemById(db, target.id), movedAliasKinds: [] };
        }
        throw new UserProfileMergeError(
          `source profile ${sourceProfileId} is already merged into ${source.id}`,
        );
      }
      const kysely = userProfilesDb(db);
      const cohort = kysely
        .selectFrom("user_profiles")
        .select("id")
        .where((eb) => eb.or([eb("id", "=", source.id), eb("merged_into", "=", source.id)]));
      const email = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select("email")
          .where("profile_id", "in", cohort)
          .limit(1),
      );
      const identities = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("user_profile_identities")
          .select((eb) =>
            eb
              .case()
              .when("provider", "=", CHANNEL_IDENTITY_PROVIDER)
              .then("channel" as const)
              .else("provider" as const)
              .end()
              .as("kind"),
          )
          .distinct()
          .where("profile_id", "in", cohort),
      ).rows;
      const movedAliasKinds: UsersMergeResult["movedAliasKinds"] = [
        ...(email ? ["email" as const] : []),
        ...(["provider", "channel"] as const).filter((kind) =>
          identities.some((identity) => identity.kind === kind),
        ),
      ];
      mergeUserProfiles(db, source.id, target.id, Date.now(), options.mutation);
      publishUserProfilesChange(db, target.id);
      return { profile: selectUserProfileListItemById(db, target.id), movedAliasKinds };
    },
    options,
    { operationLabel: "user-profiles.merge" },
  );
}

/** Links an email to a profile and retains an aliasless prior profile as a merge tombstone. */
export function linkEmail(
  email: string,
  targetProfileId: string,
  options: UserProfileMutationOptions = {},
): UserProfileListItem {
  const normalizedEmail = normalizeEmail(email);
  const now = Date.now();
  ensureUserProfilesSchema(options);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      const target = requireResolvedUserProfileMetadataById(db, targetProfileId);
      if (targetProfileId === GATEWAY_OWNER_PROFILE_ID || target.id === GATEWAY_OWNER_PROFILE_ID) {
        throw new UserProfileOwnerError("merge");
      }
      const existingAlias = selectUserProfileEmailAlias(db, normalizedEmail);
      if (existingAlias?.profile_id === GATEWAY_OWNER_PROFILE_ID) {
        throw new UserProfileOwnerError("merge");
      }
      if (existingAlias?.profile_id === target.id) {
        return selectUserProfileListItemById(db, target.id);
      }
      const changedIds = [target.id, ...(existingAlias ? [existingAlias.profile_id] : [])];
      options.mutation?.before(db, ...changedIds);
      setUserProfileEmailBinding(db, normalizedEmail, target.id, now);
      const remainingAliases = existingAlias
        ? executeSqliteQuerySync(
            db,
            kysely
              .selectFrom("user_profile_emails")
              .select("email")
              .where("profile_id", "=", existingAlias.profile_id),
          ).rows
        : [];
      executeSqliteQuerySync(
        db,
        kysely.updateTable("user_profiles").set({ updated_at: now }).where("id", "=", target.id),
      );
      if (existingAlias) {
        if (remainingAliases.length === 0) {
          mergeUserProfiles(db, existingAlias.profile_id, target.id, now, options.mutation);
        } else {
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("user_profiles")
              .set({ updated_at: now })
              .where("id", "=", existingAlias.profile_id),
          );
        }
      }
      options.mutation?.authority(...changedIds);
      publishUserProfileAuthorityChange(db, ...changedIds);
      options.mutation?.publish(...changedIds);
      publishUserProfilesChange(db, ...changedIds);
      return selectUserProfileListItemById(db, target.id);
    },
    options,
    { operationLabel: "user-profiles.link-email" },
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
    /** OIDC enrichment must retain the authenticated email profile and its credit preference. */
    preserveEmailProfile?: boolean;
  },
  options: UserProfileMutationOptions = {},
): UserProfileListItem {
  const alias = normalizeGitHubAuthenticationAlias(params.authenticationAlias);
  const githubDisplayName = normalizeInitialDisplayName(params.identity.name);
  const initialDisplayName =
    githubDisplayName ?? normalizeInitialDisplayName(params.initialDisplayName);
  ensureUserProfilesSchema(options);
  ensureUserPreferencesSchema(options);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const now = Date.now();
      const binding = applyVerifiedGitHubIdentity({
        db,
        mutation: options.mutation,
        alias,
        identity: params.identity,
        preserveEmailProfile: params.preserveEmailProfile,
        createProfile: () => insertUserProfile(db, initialDisplayName, now, options.mutation).id,
        mergeProfiles: (sourceProfileId, targetProfileId) =>
          mergeUserProfiles(db, sourceProfileId, targetProfileId, now, options.mutation),
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
      options.mutation?.before(db, profile.id);
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ display_name: displayName, updated_at: now })
          .where("id", "=", profile.id),
      );
      options.mutation?.publish(profile.id);
      publishUserProfilesChange(db, profile.id);
      return { ...profile, displayName, updatedAt: now };
    },
    options,
    { operationLabel: "user-profiles.sync-github-identity" },
  );
}

export function setDisplayName(
  profileId: string,
  name: string | null,
  options: UserProfileMutationOptions = {},
): UserProfileListItem {
  const now = Date.now();
  ensureUserProfilesSchema(options);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileMetadataById(db, profileId);
      options.mutation?.before(db, profile.id);
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ display_name: name, updated_at: now })
          .where("id", "=", profile.id),
      );
      options.mutation?.publish(profile.id);
      publishUserProfilesChange(db, profile.id);
      return selectUserProfileListItemById(db, profile.id);
    },
    options,
    { operationLabel: "user-profiles.set-display-name" },
  );
}

export function setAvatar(
  profileId: string,
  bytes: Uint8Array,
  mime: string,
  options: UserProfileMutationOptions = {},
): Result<UserProfileListItem, UserProfileAvatarError> {
  if (bytes.byteLength > MAX_USER_PROFILE_AVATAR_BYTES) {
    return err({ code: "avatar_too_large", maxBytes: MAX_USER_PROFILE_AVATAR_BYTES });
  }
  if (!USER_PROFILE_AVATAR_MIME_TYPES.some((candidate) => candidate === mime)) {
    return err({ code: "unsupported_avatar_mime", mime });
  }
  const now = Date.now();
  ensureUserProfilesSchema(options);
  const value = runUserProfileWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileMetadataById(db, profileId);
      options.mutation?.before(db, profile.id);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ avatar: bytes, avatar_mime: mime, avatar_sha256: sha256, updated_at: now })
          .where("id", "=", profile.id),
      );
      options.mutation?.publish(profile.id);
      publishUserProfilesChange(db, profile.id);
      return selectUserProfileListItemById(db, profile.id);
    },
    options,
    { operationLabel: "user-profiles.set-avatar" },
  );
  return ok(value);
}
