/**
 * Mythos Vector Engine — TypeScript Integration
 *
 * Drop-in replacement for sqlite-vec vector search in the memory-core plugin.
 * Integrates with extensions/memory-core/src/memory/manager-search.ts
 *
 * Usage in manager-search.ts:
 *
 *   import { createNativeVectorSearch } from "../../mythos-native/vector-engine.js";
 *
 *   // Replace searchVector() implementation:
 *   const nativeSearch = createNativeVectorSearch(manager);
 *   if (nativeSearch) {
 *     return nativeSearch(query, topK);
 *   }
 *   // Fallback to existing sqlite-vec implementation
 *   return legacySearchVector(manager, query, topK);
 */

import type {
  NativeVectorIndex,
  NativeVectorIndexInstance,
  NativeSearchResult,
} from "./index.js";

let vectorModule: NativeVectorIndex | null = null;
let loadAttempted = false;

async function ensureVectorModule(): Promise<NativeVectorIndex | null> {
  if (loadAttempted) return vectorModule;
  loadAttempted = true;

  try {
    vectorModule = (await import(
      "@openclaw/mythos-vector-engine"
    )) as unknown as NativeVectorIndex;
  } catch {
    vectorModule = null;
  }

  return vectorModule;
}

/**
 * Create a native vector search function that replaces the sqlite-vec path.
 *
 * Returns null if the native module is not available, signaling that
 * the caller should fall back to the existing JS implementation.
 */
export async function createNativeVectorSearch(params: {
  indexPath: string;
  dimensions: number;
}): Promise<NativeVectorIndexInstance | null> {
  const mod = await ensureVectorModule();
  if (!mod) return null;

  try {
    return mod.load(params.indexPath);
  } catch {
    // Index doesn't exist yet — create a new one
    try {
      return new mod(params.dimensions, "cosine");
    } catch {
      return null;
    }
  }
}

/**
 * Search using the native HNSW index.
 * This is the primary integration point with memory-core.
 */
export async function nativeVectorSearch(
  index: NativeVectorIndexInstance,
  query: number[],
  topK: number,
): Promise<NativeSearchResult[]> {
  return index.search(query, topK);
}

/**
 * Check if the native vector engine is available.
 */
export async function isNativeVectorAvailable(): Promise<boolean> {
  const mod = await ensureVectorModule();
  return mod !== null;
}
