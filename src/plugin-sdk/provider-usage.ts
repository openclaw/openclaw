// Public usage fetch helpers for provider plugins.

export type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "../infra/provider-usage.types.js";

export {
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchGeminiUsage,
  fetchMinimaxUsage,
  fetchZaiUsage,
} from "../infra/provider-usage.fetch.js";
export { clampPercent, PROVIDER_LABELS } from "../infra/provider-usage.shared.js";
export {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  fetchJson,
} from "../infra/provider-usage.fetch.shared.js";

/**
 * @deprecated Compatibility stub for external provider plugins that imported
 * the retired Pi auth bridge. OpenClaw no longer reads Pi auth state; provider
 * plugins should use auth profiles, config, or provider-owned auth.
 */
export function resolveLegacyAgentAccessToken(
  _env: NodeJS.ProcessEnv,
  _providerIds: string[],
): undefined {
  return undefined;
}

/**
 * @deprecated Use provider-owned auth. Kept only so old provider plugins still
 * link while the Pi auth bridge stays retired.
 */
export const resolveLegacyPiAgentAccessToken = resolveLegacyAgentAccessToken;
