import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { normalizeProfileEmail } from "./user-profile-email.kernel.js";
import { captureUserProfileAuthorityRead } from "./user-profile-events.js";
import {
  isUserProfileCatalogReady,
  prepareUserProfileCatalog,
  readUserProfileSnapshot,
  readResidentGatewayOwnerProfile,
  readResidentUserProfileForEmail,
} from "./user-profile-list.js";
import type {
  CachedGitHubIdentity,
  CachedGitHubIdentityBinding,
  ExistingUserProfileAuthentication,
} from "./user-profiles.types.js";

type ProfileReadOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env">;

/** A profile merge or identity change raced a disclosure read; a fresh read can succeed. */
export class UserProfileDisclosureChangedError extends Error {}

/** Fresh identity snapshots avoid foreign-process catalog reuse; local mutations fence consumption. */
export async function prepareCurrentUserProfileIdentity(
  profileId: string,
  options: ProfileReadOptions = {},
) {
  const context = captureOpenClawStateWorkerContext(options);
  // Incoming merges change the target's alias cohort, but not its identity cell.
  const authority = await captureUserProfileAuthorityRead(context.admission);
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "userProfiles.identity", profileId },
    { context, current: true },
  );
  const profile = reply?.profile;
  const isCurrent = authority.bind([profileId, profile?.profileId ?? profileId]);
  const assertCurrent = () => {
    if (!isCurrent?.()) {
      throw new UserProfileDisclosureChangedError(
        "Profile identity changed while preparing disclosure. Retry the request.",
      );
    }
  };
  assertCurrent();
  return { profile, assertCurrent };
}

/** Fresh disclosure aliases retain their physical store and merge authority across caller waits. */
export async function prepareCurrentUserProfileAliases(
  profileId: string,
  options: ProfileReadOptions = {},
) {
  const context = captureOpenClawStateWorkerContext(options);
  const authority = await captureUserProfileAuthorityRead(context.admission, undefined, "identity");
  const catalog = await prepareUserProfileCatalog({
    ...options,
    path: context.admission.databasePath,
  });
  let profile;
  try {
    profile = catalog.readCurrentIdentity(profileId);
  } finally {
    catalog.release();
  }
  const isCurrent = authority.bind([profileId, profile?.profileId ?? profileId]);
  const assertCurrent = () => {
    if (!isCurrent?.()) {
      throw new UserProfileDisclosureChangedError(
        "Profile aliases changed while preparing disclosure. Retry the request.",
      );
    }
  };
  assertCurrent();
  return { aliases: new Set(profile?.aliases ?? [profileId]), assertCurrent };
}

export async function resolveCanonicalCachedGitHubIdentity(
  binding: CachedGitHubIdentityBinding,
  options: ProfileReadOptions = {},
): Promise<CachedGitHubIdentity | undefined> {
  const pathname = resolveDatabasePath(options);
  if ("email" in binding && isUserProfileCatalogReady(pathname)) {
    const catalog = await prepareUserProfileCatalog(options);
    try {
      return catalog.readCurrentGitHubEmailIdentity(binding.accountId, binding.email);
    } finally {
      catalog.release();
    }
  }
  // Standalone callers and login aliases still need the worker's exact binding lookup.
  const reply = await executeExistingOpenClawStateRead(options, {
    type: "userProfiles.githubIdentity.cached",
    ...binding,
  });
  if (!reply) {
    return undefined;
  }
  return reply.identity;
}

export async function listProfiles(options: ProfileReadOptions = {}) {
  return (await readUserProfileSnapshot(undefined, options)).profiles;
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

/** Read-only connect admission retains the existing profile writer's identity and role facts. */
export async function prepareExistingUserProfileAuthentication(
  selector: ExistingUserProfileAuthentication,
  options: ProfileReadOptions = {},
) {
  const context = captureOpenClawStateWorkerContext(options);
  const authority = await captureUserProfileAuthorityRead(context.admission);
  const captured = { path: context.admission.databasePath, env: context.environment };
  let profile: CachedGitHubIdentity | undefined;
  let profileIds: string[] = [];
  if (selector.kind === "github") {
    profile = await resolveCanonicalCachedGitHubIdentity(selector.binding, captured);
  } else if (selector.kind === "owner" || selector.kind === "email") {
    const catalog = await prepareUserProfileCatalog(captured);
    try {
      const existing =
        selector.kind === "owner"
          ? readResidentGatewayOwnerProfile(captured.path)
          : readResidentUserProfileForEmail(normalizeProfileEmail(selector.email), captured.path);
      profile = existing && { profileId: existing.id, updatedAt: existing.updatedAt };
    } finally {
      catalog.release();
    }
  } else {
    const reply = await executeExistingOpenClawStateRead(
      captured,
      {
        type: "userProfiles.authenticationIdentity",
        selector,
      },
      { context, current: true },
    );
    profile = reply?.result?.profile;
    profileIds = reply?.result?.profileIds ?? [];
  }
  const isCurrent = authority.bind(profile ? [...profileIds, profile.profileId] : []);
  const assertCurrent = () => {
    if (!isCurrent?.()) {
      throw new UserProfileDisclosureChangedError(
        "Profile authentication binding changed. Retry the connection.",
      );
    }
  };
  assertCurrent();
  return { profile, assertCurrent };
}

export type { ExistingUserProfileAuthentication } from "./user-profiles.types.js";
