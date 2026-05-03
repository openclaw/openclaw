import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "../../agents/provider-auth-aliases.js";
import type { FollowupRun } from "./queue.js";

export function resolveProviderScopedAuthProfile(params: {
  provider: string;
  primaryProvider: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  authProfileIdCompactionCount?: number;
  config?: ProviderAuthAliasLookupParams["config"];
  workspaceDir?: ProviderAuthAliasLookupParams["workspaceDir"];
}): {
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  authProfileIdCompactionCount?: number;
} {
  const aliasParams = { config: params.config, workspaceDir: params.workspaceDir };
  const authProfileId =
    resolveProviderIdForAuth(params.provider, aliasParams) ===
    resolveProviderIdForAuth(params.primaryProvider, aliasParams)
      ? params.authProfileId
      : undefined;
  const authProfileIdSource = authProfileId
    ? (params.authProfileIdSource ??
      (typeof params.authProfileIdCompactionCount === "number" ? "auto" : undefined))
    : undefined;
  return {
    authProfileId,
    authProfileIdSource,
    authProfileIdCompactionCount: authProfileId ? params.authProfileIdCompactionCount : undefined,
  };
}

export function resolveRunAuthProfile(
  run: FollowupRun["run"],
  provider: string,
  params?: { config?: ProviderAuthAliasLookupParams["config"] },
) {
  return resolveProviderScopedAuthProfile({
    provider,
    primaryProvider: run.provider,
    authProfileId: run.authProfileId,
    authProfileIdSource: run.authProfileIdSource,
    authProfileIdCompactionCount: run.authProfileIdCompactionCount,
    config: params?.config ?? run.config,
    workspaceDir: run.workspaceDir,
  });
}
