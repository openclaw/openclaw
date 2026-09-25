import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { CachedGitHubIdentity } from "./user-profiles.types.js";

type ProfileReadOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env">;

export async function resolveCanonicalCachedGitHubIdentity(
  params: { accountId: number; email: string },
  options: ProfileReadOptions = {},
): Promise<CachedGitHubIdentity | undefined> {
  const reply = await executeExistingOpenClawStateRead(options, {
    type: "userProfiles.githubIdentity.cached",
    accountId: params.accountId,
    email: params.email,
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
  const context = captureOpenClawStateWorkerContext(options);
  const { executeOpenClawStateWorker } = await import("./openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "userProfiles.list",
    input: undefined,
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
