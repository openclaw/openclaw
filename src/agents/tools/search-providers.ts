/**
 * Global registry for web search providers.
 * Allows plugins to register custom search providers for the web_search tool.
 */

import type { SearchProviderPlugin } from "../../plugins/types.js";

const searchProviderRegistry = new Map<string, SearchProviderPlugin>();

export function registerSearchProvider(provider: SearchProviderPlugin): void {
  const id = provider.id.trim().toLowerCase();
  if (!id) {
    throw new Error("Search provider must have a non-empty id");
  }
  if (searchProviderRegistry.has(id)) {
    throw new Error(`Search provider "${id}" is already registered`);
  }
  searchProviderRegistry.set(id, provider);
}

export function getSearchProvider(id: string): SearchProviderPlugin | undefined {
  const normalized = id.trim().toLowerCase();
  return searchProviderRegistry.get(normalized);
}

export function listSearchProviders(): string[] {
  return Array.from(searchProviderRegistry.keys());
}

export function hasSearchProvider(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return searchProviderRegistry.has(normalized);
}

/**
 * Unregister a search provider (primarily for testing).
 */
export function unregisterSearchProvider(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return searchProviderRegistry.delete(normalized);
}

/**
 * Clear all registered providers (primarily for testing).
 */
export function clearSearchProviders(): void {
  searchProviderRegistry.clear();
}
