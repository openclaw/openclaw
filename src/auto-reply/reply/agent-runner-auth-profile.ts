// Resolves auth profile settings that agent runner forwards to providers.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveCliExecutionAuthProfileId } from "../../agents/cli-execution-auth.js";
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FollowupRun } from "./queue.js";

/** Keeps an auth profile only when the current provider shares the primary auth scope. */
export function resolveProviderScopedAuthProfile(params: {
  provider: string;
  primaryProvider: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  config?: ProviderAuthAliasLookupParams["config"];
  workspaceDir?: ProviderAuthAliasLookupParams["workspaceDir"];
}): { authProfileId?: string; authProfileIdSource?: "auto" | "user" } {
  const aliasParams = { config: params.config, workspaceDir: params.workspaceDir };
  const providerId = normalizeProviderId(params.provider);
  const primaryProviderId = normalizeProviderId(params.primaryProvider);
  const sharesAuthScope =
    (providerId !== "" && providerId === primaryProviderId) ||
    resolveProviderIdForAuth(params.provider, aliasParams) ===
      resolveProviderIdForAuth(params.primaryProvider, aliasParams);
  const authProfileId = sharesAuthScope ? params.authProfileId : undefined;
  return {
    authProfileId,
    authProfileIdSource: authProfileId ? params.authProfileIdSource : undefined,
  };
}

/** Resolves the auth profile override for a queued follow-up run. */
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
    config: params?.config ?? run.config,
    workspaceDir: run.workspaceDir,
  });
}

/**
 * Converts the session-layer profile selection into the CLI execution identity
 * at the dispatch boundary. A session pin resolved for the model provider (for
 * example "anthropic:default") must not reach a claude-cli child as a forwarded
 * API key when auth.order names the backend's native login; the gateway command
 * path applies the same filter before preparing its runs.
 */
export function resolveCliExecutionForwardedAuthProfileId(params: {
  cliExecutionProvider: string;
  authProfileProvider: string;
  config: OpenClawConfig;
  agentDir: string;
  selected: { authProfileId?: string; authProfileIdSource?: "auto" | "user" };
}): string | undefined {
  return resolveCliExecutionAuthProfileId({
    cliExecutionProvider: params.cliExecutionProvider,
    authProfileProvider: params.authProfileProvider,
    config: params.config,
    agentDir: params.agentDir,
    selected: params.selected,
  });
}

/** Applies an auto-fallback probe's pinned auth to its fallback candidate. */
export function resolveFallbackCandidateRun(
  run: FollowupRun["run"],
  provider: string,
  model: string,
): FollowupRun["run"] {
  const probe = run.autoFallbackPrimaryProbe;
  const isPrimaryProbeCandidate = probe && provider === probe.provider && model === probe.model;
  if (
    !probe ||
    provider !== probe.fallbackProvider ||
    isPrimaryProbeCandidate ||
    !probe.fallbackAuthProfileId
  ) {
    return run;
  }
  const candidateRun: FollowupRun["run"] = {
    ...run,
    provider,
    model,
    authProfileId: probe.fallbackAuthProfileId,
  };
  if (probe.fallbackAuthProfileIdSource) {
    candidateRun.authProfileIdSource = probe.fallbackAuthProfileIdSource;
  } else {
    delete candidateRun.authProfileIdSource;
  }
  return candidateRun;
}
