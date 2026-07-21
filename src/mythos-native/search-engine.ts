/**
 * Mythos Search Engine — TypeScript Integration
 *
 * Drop-in replacement for SQLite FTS5 in the memory-core plugin.
 * Integrates with extensions/memory-core/src/memory/manager-search.ts
 *
 * Usage:
 *   import { createNativeTextSearch } from "../../mythos-native/search-engine.js";
 *
 *   const nativeSearch = createNativeTextSearch({ indexPath: "..." });
 *   if (nativeSearch) {
 *     return nativeSearch.search(query, topK);
 *   }
 *   // Fallback to existing FTS5 implementation
 */

import type {
  NativeSearchIndex,
  NativeSearchIndexInstance,
  NativeTextSearchResult,
  NativeSearchFilters,
} from "./index.js";

let searchModule: NativeSearchIndex | null = null;
let loadAttempted = false;

async function ensureSearchModule(): Promise<NativeSearchIndex | null> {
  if (loadAttempted) return searchModule;
  loadAttempted = true;

  try {
    searchModule = (await import(
      "@openclaw/mythos-search-engine"
    )) as unknown as NativeSearchIndex;
  } catch {
    searchModule = null;
  }

  return searchModule;
}

/**
 * Create a native text search instance.
 * Returns null if the native module is not available.
 */
export async function createNativeTextSearch(params: {
  indexPath: string;
  tokenizer?: string;
}): Promise<NativeSearchIndexInstance | null> {
  const mod = await ensureSearchModule();
  if (!mod) return null;

  try {
    return new mod(params.indexPath, params.tokenizer);
  } catch {
    return null;
  }
}

/**
 * Search using the native Tantivy BM25 index.
 */
export async function nativeTextSearch(
  index: NativeSearchIndexInstance,
  query: string,
  topK: number,
  filters?: NativeSearchFilters,
): Promise<NativeTextSearchResult[]> {
  return index.search(query, topK, filters);
}

/**
 * Check if the native search engine is available.
 */
export async function isNativeSearchAvailable(): Promise<boolean> {
  const mod = await ensureSearchModule();
  return mod !== null;
}
