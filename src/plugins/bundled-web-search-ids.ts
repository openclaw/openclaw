export const BUNDLED_WEB_SEARCH_PLUGIN_IDS = [
  "brave",
  "firecrawl",
  "google",
  "moonshot",
  "perplexity",
  "searxng",
  "tavily",
  "xai",
] as const;

export function listBundledWebSearchPluginIds(): string[] {
  return [...BUNDLED_WEB_SEARCH_PLUGIN_IDS];
}
