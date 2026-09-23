import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexFacts,
} from "./installed-plugin-index-types.js";
import { getPluginCache } from "./plugin-cache.js";

/** Package facts share the existing generation; mutable management inputs stay uncached. */
export function getInstalledPluginIndexFacts(
  index: InstalledPluginIndex,
): InstalledPluginIndexFacts | undefined {
  const entries = getPluginCache().metadata.indexFacts;
  const existing = entries.get(index);
  if (existing) {
    return existing;
  }
  if (!isDeeplyFrozenPlainData(index)) {
    return undefined;
  }
  const facts: InstalledPluginIndexFacts = {};
  entries.set(index, facts);
  return facts;
}
