import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { CODEX_APP_SERVER_AUTH_MARKER } from "../agents/model-auth-markers.js";
import type { ProviderAuth } from "../infra/provider-usage.auth.js";
import type { ProviderUsageSnapshot, UsageSummary } from "../infra/provider-usage.types.js";

export const CODEX_SYNTHETIC_USAGE_PROVIDER = "openai";
export const CODEX_SYNTHETIC_USAGE_HOOK_PROVIDER = "codex";

export function buildCodexSyntheticUsageAuth(
  params: {
    authProfileId?: string;
  } = {},
): ProviderAuth {
  return {
    provider: CODEX_SYNTHETIC_USAGE_PROVIDER,
    token: CODEX_APP_SERVER_AUTH_MARKER,
    ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
    hookProvider: CODEX_SYNTHETIC_USAGE_HOOK_PROVIDER,
  };
}

export function shouldUseCodexSyntheticUsageForRuntime(params: {
  provider?: string;
  effectiveHarness?: string;
}): boolean {
  const harness = normalizeOptionalLowercaseString(params.effectiveHarness);
  const provider = normalizeOptionalLowercaseString(params.provider);
  return (
    harness === CODEX_SYNTHETIC_USAGE_HOOK_PROVIDER &&
    (provider === CODEX_SYNTHETIC_USAGE_PROVIDER || provider === "codex")
  );
}

function hasDisplayableUsageSnapshot(snapshot: ProviderUsageSnapshot): boolean {
  return snapshot.windows.length > 0 || Boolean(snapshot.summary?.trim());
}

function usageSnapshotRank(snapshot: ProviderUsageSnapshot): number {
  if (hasDisplayableUsageSnapshot(snapshot)) {
    return 2;
  }
  return snapshot.error ? 0 : 1;
}

export function mergeUsageSummaries(
  base: UsageSummary,
  extra: UsageSummary | undefined,
): UsageSummary {
  if (!extra || extra.providers.length === 0) {
    return base;
  }
  const providersById = new Map(base.providers.map((provider) => [provider.provider, provider]));
  for (const provider of extra.providers) {
    const existing = providersById.get(provider.provider);
    if (!existing || usageSnapshotRank(provider) >= usageSnapshotRank(existing)) {
      providersById.set(provider.provider, provider);
    }
  }
  return {
    updatedAt: base.updatedAt,
    providers: [...providersById.values()],
  };
}
