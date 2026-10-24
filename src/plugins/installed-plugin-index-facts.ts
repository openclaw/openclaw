import type {
  InstalledPluginIndex,
  InstalledPluginIndexFacts,
} from "./installed-plugin-index-types.js";
import { getPluginCache } from "./plugin-cache.js";

/** The admitted index owns these facts; publish replacements instead of mutating it. */
export function getInstalledPluginIndexFacts(
  index: InstalledPluginIndex,
): InstalledPluginIndexFacts {
  const entries = getPluginCache().metadata.indexFacts;
  const existing = entries.get(index);
  if (existing) {
    return existing;
  }
  const facts: InstalledPluginIndexFacts = {};
  entries.set(index, facts);
  return facts;
}
