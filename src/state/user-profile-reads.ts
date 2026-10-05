import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "./openclaw-state-worker-context.js";
import { normalizeProfileEmail } from "./user-profile-email.kernel.js";
import type { UserProfileAvatarInspection } from "./user-profiles-avatar.types.js";
import {
  classifyTailscaleLogin,
  type TailscaleProfileIdentity,
} from "./user-profiles-tailscale-login.js";
import type {
  CachedGitHubIdentity,
  CachedGitHubIdentitySelector,
  CachedGitHubIdentityBinding,
  ExistingUserProfileAuthenticationAlias,
} from "./user-profiles.types.js";

type ProfileReadOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env">;

/** Read stored image and metadata from one physical snapshot without borrowing writer admission. */
export async function getUserProfileAvatarDataReadOnly(
  profileId: string,
  options: ProfileReadOptions = {},
  shouldLoadBytes: (avatar: NonNullable<UserProfileAvatarInspection["avatar"]>) => boolean = () =>
    true,
): Promise<
  Omit<UserProfileAvatarInspection, "avatar"> & {
    avatar:
      | (NonNullable<UserProfileAvatarInspection["avatar"]> & { bytes?: Uint8Array })
      | undefined;
  }
> {
  const context = captureOpenClawStateReadWorkerContext(options);
  const location = { path: context.admission.databasePath, env: context.environment };
  return await withArtifactPreservingStateReads(() =>
    withOpenClawStateDatabaseReadSnapshot(async () => {
      const inspected = await executeExistingOpenClawStateRead(
        location,
        { type: "userProfiles.avatar.inspect", profileId },
        { context },
      );
      context.admission.assertCurrent();
      if (inspected && (!inspected.ok || inspected.type !== "userProfiles.avatar.inspect")) {
        throw new Error("User avatar reader returned an unexpected inspection");
      }
      const inspection = inspected?.inspection ?? {
        profile: undefined,
        hasAvatar: false,
        emails: [],
      };
      const { profile, avatar } = inspection;
      if (!profile || !avatar) {
        return { ...inspection, avatar: undefined };
      }
      if (!shouldLoadBytes(avatar)) {
        return { ...inspection, avatar };
      }
      const loaded = await executeExistingOpenClawStateRead(
        location,
        {
          type: "userProfiles.avatar.read",
          profileId,
          expected: { canonicalProfileId: profile.id, sha256: avatar.sha256, mime: avatar.mime },
        },
        { context },
      );
      context.admission.assertCurrent();
      if (!loaded || !loaded.ok || loaded.type !== "userProfiles.avatar.read" || !loaded.avatar) {
        throw new Error("Frozen avatar representation changed before materialization");
      }
      return { ...inspection, avatar: { ...avatar, bytes: loaded.avatar.bytes } };
    }, location),
  );
}

export async function readCanonicalUserProfileListItem(profileId: string) {
  const reply = await executeExistingOpenClawStateRead(
    {},
    { type: "userProfiles.self", profileId },
    { current: true },
  );
  if (!reply || !reply.ok || reply.type !== "userProfiles.self") {
    throw new Error("User profile reader returned an unexpected result");
  }
  return reply.profile;
}

export async function readCanonicalExistingProfileForEmail(
  email: string,
  options: ProfileReadOptions = {},
) {
  return await readCanonicalExistingProfileForAuthenticationAlias(
    { kind: "email", email: normalizeProfileEmail(email) },
    options,
  );
}

export async function readCanonicalExistingProfileForTailscaleIdentity(
  identity: TailscaleProfileIdentity,
  options: ProfileReadOptions = {},
) {
  const alias = classifyTailscaleLogin(identity.login);
  if (alias.kind === "invalid") {
    throw new Error("Tailscale identity is invalid");
  }
  if (alias.kind === "provider" && alias.provider === "github") {
    throw new Error(
      "Existing GitHub provider identity requires its verified numeric account binding",
    );
  }
  return await readCanonicalExistingProfileForAuthenticationAlias(
    alias.kind === "email" ? { ...alias, email: normalizeProfileEmail(alias.email) } : alias,
    options,
  );
}

async function readCanonicalExistingProfileForAuthenticationAlias(
  alias: ExistingUserProfileAuthenticationAlias,
  options: ProfileReadOptions,
) {
  const reply = await executeExistingOpenClawStateRead(options, {
    type: "userProfiles.authenticationAlias.resolve",
    alias,
  });
  if (
    !reply ||
    !reply.ok ||
    reply.type !== "userProfiles.authenticationAlias.resolve" ||
    !reply.profileId ||
    reply.updatedAt === undefined
  ) {
    throw new Error("Authenticated profile is absent from the frozen Gateway generation");
  }
  return { id: reply.profileId, updatedAt: reply.updatedAt };
}

export async function resolveCanonicalCachedGitHubIdentity(
  binding: CachedGitHubIdentityBinding | CachedGitHubIdentitySelector,
  options: ProfileReadOptions = {},
): Promise<CachedGitHubIdentity | undefined> {
  const reply = await executeExistingOpenClawStateRead(options, {
    type: "userProfiles.githubIdentity.cached",
    ...binding,
  });
  if (!reply) {
    return undefined;
  }
  if (!reply.ok || reply.type !== "userProfiles.githubIdentity.cached") {
    throw new Error("Cached GitHub identity reader returned an unexpected result");
  }
  return reply.identity;
}

export async function listProfiles(options: ProfileReadOptions = {}) {
  return (await readUserProfileSnapshot(undefined, options)).profiles;
}

export async function readUserProfileSnapshot(
  githubAccountIds?: readonly number[],
  options: ProfileReadOptions = {},
) {
  const context = captureOpenClawStateWorkerContext(options);
  const { executeOpenClawStateWorker } = await import("./openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "userProfiles.list",
    input: githubAccountIds ? { githubAccountIds } : undefined,
  });
}

/** Candidate IDs and search labels; current recipient policy remains caller-owned. */
export async function readUserProfileDirectory(limit: number, options: ProfileReadOptions = {}) {
  const context = captureOpenClawStateWorkerContext(options);
  const { executeOpenClawStateWorker } = await import("./openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "userProfiles.directory",
    input: { limit },
  });
}
