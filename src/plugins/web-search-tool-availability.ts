/**
 * Validates that web_search is only requested when at least one web search
 * provider is available. Returns a diagnostic warning when the tool is in
 * toolsAllow but no provider plugin is enabled — this prevents silent
 * failures where the model apologizes instead of searching.
 */
import type { PluginWebSearchProviderEntry } from "./types.js";

export type WebSearchAvailabilityCheck = {
  /** Human-readable warning when web_search is requested but unavailable. */
  warning: string;
};

const WARNING_TEXT =
  "web_search is in toolsAllow but no web search provider plugin is enabled. " +
  "Enable one with: openclaw plugins enable duckduckgo";

/**
 * Resolves whether the requested toolsAllow list includes web_search while
 * no web search providers are currently available.
 *
 * Returns `undefined` when everything is fine (no warning needed).
 * Returns a {@link WebSearchAvailabilityCheck} with a diagnostic warning
 * when web_search is requested but has no registered provider.
 */
export function checkWebSearchAvailability(params: {
  toolsAllow?: string[] | null;
  providers: PluginWebSearchProviderEntry[];
}): WebSearchAvailabilityCheck | undefined {
  const hasWebSearch = params.toolsAllow?.includes("web_search");
  if (!hasWebSearch) {
    return undefined;
  }
  if (params.providers.length === 0) {
    return { warning: WARNING_TEXT };
  }
  return undefined;
}
