import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import {
  publishUserProfileAuthorityChange,
  publishUserProfileIdentityChange,
} from "./user-profile-events.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import {
  runUserProfileWriteTransaction,
  type UserProfileMutationOptions,
} from "./user-profile-mutation.js";
import {
  openClawIdProfileProvider,
  type OpenClawIdProfileDisplayMetadata,
  type OpenClawIdUserProfileInput,
} from "./user-profile-openclaw-id.types.js";
import {
  insertUserProfile,
  requireResolvedUserProfileMetadataById,
  toUserProfile,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import { normalizeInitialDisplayName } from "./user-profiles.js";
import { MAX_USER_PROFILE_DISPLAY_NAME_LENGTH, type UserProfile } from "./user-profiles.types.js";

// This column is provider-scoped: the discriminant deliberately cannot be GitHub email proof.
function displayMetadata(email: string | null): string {
  const metadata: OpenClawIdProfileDisplayMetadata = { kind: "openclaw-id-display", email };
  return JSON.stringify(metadata);
}

/** Creates only an exact OCID binding, preserving edits and never establishing email aliases. */
export function ensureOpenClawIdUserProfile(
  input: OpenClawIdUserProfileInput,
  options: UserProfileMutationOptions,
): UserProfile {
  const name = normalizeInitialDisplayName(input.name);
  const email = input.email?.trim();
  const metadata =
    input.email === undefined
      ? undefined
      : displayMetadata(
          email ? truncateUtf16Safe(email, MAX_USER_PROFILE_DISPLAY_NAME_LENGTH) : null,
        );
  ensureUserProfilesSchema(options);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      // OCID is an opaque, case-sensitive account key. Reported email never participates.
      const identity = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_identities")
          .select(["profile_id", "verified_email_json"])
          .where("provider", "=", openClawIdProfileProvider)
          .where("subject", "=", input.accountId),
      );
      const now = Date.now();
      const profile = identity
        ? requireResolvedUserProfileMetadataById(db, identity.profile_id)
        : insertUserProfile(db, name, now, options.mutation);
      const adoptsName = Boolean(name && !profile.display_name?.trim());
      const changesEmail = metadata !== undefined && metadata !== identity?.verified_email_json;
      if (identity && !adoptsName && !changesEmail) {
        return toUserProfile(profile);
      }
      options.mutation?.before(db, profile.id);
      if (!identity) {
        executeSqliteQuerySync(
          db,
          kysely.insertInto("user_profile_identities").values({
            provider: openClawIdProfileProvider,
            subject: input.accountId,
            profile_id: profile.id,
            canonical_login: null,
            verified_email_json: metadata ?? null,
            created_at: now,
          }),
        );
        options.mutation?.authority(profile.id);
        options.mutation?.identity(profile.id);
        publishUserProfileAuthorityChange(db, profile.id);
        publishUserProfileIdentityChange(db, profile.id);
      } else if (changesEmail) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("user_profile_identities")
            .set({ verified_email_json: metadata })
            .where("provider", "=", openClawIdProfileProvider)
            .where("subject", "=", input.accountId),
        );
      }
      // Adopt only empty names; metadata-free authentication retains both display fields.
      const displayName = adoptsName ? name : profile.display_name;
      if (identity) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("user_profiles")
            .set({ display_name: displayName, updated_at: now })
            .where("id", "=", profile.id),
        );
      }
      options.mutation?.publish(profile.id);
      publishUserProfilesChange(db, profile.id);
      return toUserProfile({ ...profile, display_name: displayName, updated_at: now });
    },
    options,
    { operationLabel: "user-profiles.openclaw-id" },
  );
}

/** Why a link was refused: the account belongs to another profile, or this one has another. */
export type OpenClawIdLinkResult =
  | { ok: true }
  | { ok: false; code: "owner_profile" | "linked_elsewhere" | "profile_linked" };

/**
 * Links an OpenClaw ID account to an existing personal profile, as a provider identity.
 * One profile per account and one account per profile; the shared owner profile never
 * holds one. The caller proves both sides on one connection; linking grants nothing.
 */
export function linkOpenClawIdUserProfile(
  input: { profileId: string; accountId: string; email: string | null },
  options: UserProfileMutationOptions,
): OpenClawIdLinkResult {
  ensureUserProfilesSchema(options);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      const target = requireResolvedUserProfileMetadataById(db, input.profileId);
      if (target.id === GATEWAY_OWNER_PROFILE_ID) {
        return { ok: false, code: "owner_profile" };
      }
      const holder = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_identities")
          .select("profile_id")
          .where("provider", "=", openClawIdProfileProvider)
          .where("subject", "=", input.accountId),
      );
      if (holder) {
        return requireResolvedUserProfileMetadataById(db, holder.profile_id).id === target.id
          ? { ok: true }
          : { ok: false, code: "linked_elsewhere" };
      }
      const other = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_identities")
          .select("subject")
          .where("provider", "=", openClawIdProfileProvider)
          .where("profile_id", "=", target.id),
      );
      if (other) {
        return { ok: false, code: "profile_linked" };
      }
      options.mutation?.before(db, target.id);
      executeSqliteQuerySync(
        db,
        kysely.insertInto("user_profile_identities").values({
          provider: openClawIdProfileProvider,
          subject: input.accountId,
          profile_id: target.id,
          canonical_login: null,
          verified_email_json: displayMetadata(
            input.email
              ? truncateUtf16Safe(input.email, MAX_USER_PROFILE_DISPLAY_NAME_LENGTH)
              : null,
          ),
          created_at: Date.now(),
        }),
      );
      options.mutation?.authority(target.id);
      options.mutation?.identity(target.id);
      publishUserProfileAuthorityChange(db, target.id);
      publishUserProfileIdentityChange(db, target.id);
      options.mutation?.publish(target.id);
      publishUserProfilesChange(db, target.id);
      return { ok: true };
    },
    options,
    { operationLabel: "user-profiles.openclaw-id.link" },
  );
}

/** Removes this profile's OpenClaw ID link; returns whether one existed. */
export function unlinkOpenClawIdUserProfile(
  input: { profileId: string },
  options: UserProfileMutationOptions,
): { unlinked: boolean } {
  ensureUserProfilesSchema(options);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      const target = requireResolvedUserProfileMetadataById(db, input.profileId);
      const linked = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_identities")
          .select("subject")
          .where("provider", "=", openClawIdProfileProvider)
          .where("profile_id", "=", target.id),
      );
      if (!linked) {
        return { unlinked: false };
      }
      options.mutation?.before(db, target.id);
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("user_profile_identities")
          .where("provider", "=", openClawIdProfileProvider)
          .where("profile_id", "=", target.id),
      );
      options.mutation?.authority(target.id);
      options.mutation?.identity(target.id);
      publishUserProfileAuthorityChange(db, target.id);
      publishUserProfileIdentityChange(db, target.id);
      options.mutation?.publish(target.id);
      publishUserProfilesChange(db, target.id);
      return { unlinked: true };
    },
    options,
    { operationLabel: "user-profiles.openclaw-id.unlink" },
  );
}
