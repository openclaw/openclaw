import { createBaiduWebSearchProvider } from "../extensions/baidu/web-search-provider.js";
import { createBraveWebSearchProvider } from "../extensions/brave/web-search-provider.js";
import { createDuckDuckGoWebSearchProvider } from "../extensions/duckduckgo/web-search-provider.js";
import { createExaWebSearchProvider } from "../extensions/exa/web-search-provider.js";
import { createFirecrawlWebSearchProvider } from "../extensions/firecrawl/web-search-provider.js";
import { createGeminiWebSearchProvider } from "../extensions/google/web-search-provider.js";
import { createKimiWebSearchProvider } from "../extensions/moonshot/web-search-provider.js";
import { createPerplexityWebSearchProvider } from "../extensions/perplexity/web-search-provider.js";
import { createTavilyWebSearchProvider } from "../extensions/tavily/web-search-provider.js";
import { createXaiWebSearchProvider } from "../extensions/xai/web-search.js";
import type { PluginWebSearchProviderEntry } from "./plugins/types.js";

export function listBundledWebSearchProviderEntries(): PluginWebSearchProviderEntry[] {
  return [
    { pluginId: "baidu", ...createBaiduWebSearchProvider() },
    { pluginId: "brave", ...createBraveWebSearchProvider() },
    { pluginId: "duckduckgo", ...createDuckDuckGoWebSearchProvider() },
    { pluginId: "exa", ...createExaWebSearchProvider() },
    { pluginId: "firecrawl", ...createFirecrawlWebSearchProvider() },
    { pluginId: "google", ...createGeminiWebSearchProvider() },
    { pluginId: "moonshot", ...createKimiWebSearchProvider() },
    { pluginId: "perplexity", ...createPerplexityWebSearchProvider() },
    { pluginId: "tavily", ...createTavilyWebSearchProvider() },
    { pluginId: "xai", ...createXaiWebSearchProvider() },
  ];
}
