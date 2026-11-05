import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "../../agents/provider-auth-aliases.js";
import type { FollowupRun } from "./queue.js";

/** Keeps an auth profile only when the current provider shares the primary auth scope. */
export function resolveRunAuthProfile(
  run: FollowupRun["run"],
  provider: string,
  params?: { config?: ProviderAuthAliasLookupParams["config"] },
): { authProfileId?: string; authProfileIdSource?: "auto" | "user" } {
  const {
    provider: primaryProvider,
    authProfileId: requestedAuthProfileId,
    authProfileIdSource,
  } = run;
  const aliasParams = { config: params?.config ?? run.config, workspaceDir: run.workspaceDir };
  const providerId = normalizeProviderId(provider);
  const primaryProviderId = normalizeProviderId(primaryProvider);
  const sharesAuthScope =
    (providerId !== "" && providerId === primaryProviderId) ||
    resolveProviderIdForAuth(provider, aliasParams) ===
      resolveProviderIdForAuth(primaryProvider, aliasParams);
  const authProfileId = sharesAuthScope ? requestedAuthProfileId : undefined;
  return {
    authProfileId,
    authProfileIdSource: authProfileId ? authProfileIdSource : undefined,
  };
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
