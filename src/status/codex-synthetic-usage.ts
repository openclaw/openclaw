// Shared Codex synthetic usage selection for status surfaces.
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

function shouldPreferUsageSnapshot(snapshot: ProviderUsageSnapshot): boolean {
  return snapshot.windows.length > 0 || Boolean(snapshot.summary?.trim()) || !snapshot.error;
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
    if (!existing || shouldPreferUsageSnapshot(provider) || !shouldPreferUsageSnapshot(existing)) {
      providersById.set(provider.provider, provider);
    }
  }
  return {
    updatedAt: base.updatedAt,
    providers: [...providersById.values()],
  };
}
