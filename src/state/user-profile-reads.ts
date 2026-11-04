import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { captureUserProfileAuthorityRead } from "./user-profile-events.js";
import { prepareUserProfileCatalog, readUserProfileSnapshot } from "./user-profile-list.js";
import type { CachedGitHubIdentity, CachedGitHubIdentityBinding } from "./user-profiles.types.js";

type ProfileReadOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env">;

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
      throw new Error("Profile identity changed while preparing disclosure. Retry the request.");
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
      throw new Error("Profile aliases changed while preparing disclosure. Retry the request.");
    }
  };
  assertCurrent();
  return { aliases: new Set(profile?.aliases ?? [profileId]), assertCurrent };
}

export async function resolveCanonicalCachedGitHubIdentity(
  binding: CachedGitHubIdentityBinding,
  options: ProfileReadOptions = {},
): Promise<CachedGitHubIdentity | undefined> {
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
