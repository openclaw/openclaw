import type { FollowupRun } from "./queue.js";

export function resolveProviderScopedAuthProfile(params: {
  provider: string;
  primaryProvider: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  authProfileIdCompactionCount?: number;
}): {
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  authProfileIdCompactionCount?: number;
} {
  const authProfileId =
    params.provider === params.primaryProvider ? params.authProfileId : undefined;
  return {
    authProfileId,
    authProfileIdSource: authProfileId ? params.authProfileIdSource : undefined,
    authProfileIdCompactionCount: authProfileId ? params.authProfileIdCompactionCount : undefined,
  };
}

export function resolveRunAuthProfile(run: FollowupRun["run"], provider: string) {
  return resolveProviderScopedAuthProfile({
    provider,
    primaryProvider: run.provider,
    authProfileId: run.authProfileId,
    authProfileIdSource: run.authProfileIdSource,
    authProfileIdCompactionCount: run.authProfileIdCompactionCount,
  });
}
