/**
 * Search Provider Registry
 *
 * Allows plugins to register custom web search providers via `registerSearchProvider()`.
 * Registered providers integrate seamlessly with the built-in `web_search` tool.
 */

export type SearchProviderResult = {
  /** Structured results (title + URL + snippet). */
  results?: Array<{
    title: string;
    url: string;
    description: string;
    siteName?: string;
  }>;
  /** Free-form AI-synthesized content (for LLM-style providers). */
  content?: string;
  /** Citation URLs. */
  citations?: string[];
};

export type SearchProviderParams = {
  query: string;
  count: number;
  timeoutSeconds: number;
  country?: string;
  language?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
};

export type SearchProviderRegistration = {
  /** Unique provider id (e.g. "duckduckgo"). Used in config: `tools.web.search.provider`. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Tool description shown to the LLM. */
  description: string;
  /** Whether this provider requires an API key. If false, apiKey checks are skipped. */
  requiresApiKey?: boolean;
  /** Resolve the API key from config. Only called if requiresApiKey is true. */
  resolveApiKey?: (config: Record<string, unknown>) => string | undefined;
  /** Provider-specific config fields for cache key differentiation. */
  cacheKeyExtra?: (config: Record<string, unknown>) => string;
  /** Execute the search. */
  search: (
    params: SearchProviderParams,
    config: Record<string, unknown>,
  ) => Promise<SearchProviderResult>;
};

const registry = new Map<string, SearchProviderRegistration>();

export function registerSearchProviderEntry(provider: SearchProviderRegistration): void {
  if (registry.has(provider.id)) {
    throw new Error(`Search provider "${provider.id}" is already registered.`);
  }
  registry.set(provider.id, provider);
}

export function getSearchProvider(id: string): SearchProviderRegistration | undefined {
  return registry.get(id);
}

export function getRegisteredSearchProviderIds(): string[] {
  return Array.from(registry.keys());
}

export function hasSearchProvider(id: string): boolean {
  return registry.has(id);
}
