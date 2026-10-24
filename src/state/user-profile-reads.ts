import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseCurrentReadOnly,
} from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { captureUserProfileAuthorityRead } from "./user-profile-events.js";
import { selectUserProfileIdentityInDatabase } from "./user-profile-identity.read.js";
import { prepareUserProfileCatalog, readUserProfileSnapshot } from "./user-profile-list.js";
import type { CachedGitHubIdentity, CachedGitHubIdentityBinding } from "./user-profiles.types.js";

type ProfileReadOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env">;

/** Final node-host disclosure cannot borrow another process's resident profile publications. */
export function readCurrentUserProfileIdentity(
  profileId: string,
  options: ProfileReadOptions = {},
) {
  return withExistingOpenClawStateDatabaseCurrentReadOnly(
    ({ db }) =>
      tableExists(db, "user_profiles")
        ? runSqliteReadSnapshotSync(db, () => selectUserProfileIdentityInDatabase(db, profileId))
        : undefined,
    { ...options, allowNativeRead: true },
  );
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
