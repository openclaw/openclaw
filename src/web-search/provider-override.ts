import { copyConfigResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Project a run's explicit selection without changing the admitted model or plugin owner. */
export function applyRunWebSearchProvider(
  config: OpenClawConfig,
  provider: string | undefined,
): OpenClawConfig {
  if (provider === undefined) {
    return config;
  }
  const providerId = provider.trim().toLowerCase();
  if (!providerId) {
    throw new Error("webSearchProvider must be a nonblank provider ID.");
  }
  const search = config.tools?.web?.search;
  if (search?.enabled === false) {
    throw new Error("web_search is disabled; cannot apply webSearchProvider.");
  }
  // Managed providers do not share native Codex's domain-policy contract.
  if (search?.openaiCodex?.allowedDomains?.length) {
    throw new Error(
      "webSearchProvider cannot override native search with openaiCodex.allowedDomains.",
    );
  }
  const next: OpenClawConfig = {
    ...config,
    tools: {
      ...config.tools,
      web: { ...config.tools?.web, search: { ...search, provider: providerId } },
    },
  };
  copyConfigResolutionFacts(config, next);
  return next;
}
