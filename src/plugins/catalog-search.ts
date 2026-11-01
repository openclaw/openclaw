import {
  searchClawHubPackages,
  type ClawHubPackageFamily,
  type ClawHubPackageSearchResult,
} from "../infra/clawhub-packages.js";

const INSTALLABLE_PLUGIN_FAMILIES: readonly ClawHubPackageFamily[] = [
  "code-plugin",
  "bundle-plugin",
];
const DEFAULT_PLUGIN_SEARCH_LIMIT = 20;
const MAX_PLUGIN_SEARCH_LIMIT = 100;

export async function searchInstallablePluginPackages(params: {
  query: string;
  limit?: number;
}): Promise<ClawHubPackageSearchResult[]> {
  const limit =
    !Number.isFinite(params.limit) || !params.limit || params.limit <= 0
      ? DEFAULT_PLUGIN_SEARCH_LIMIT
      : Math.min(Math.max(Math.trunc(params.limit), 1), MAX_PLUGIN_SEARCH_LIMIT);
  const groups = await Promise.all(
    INSTALLABLE_PLUGIN_FAMILIES.map((family) =>
      searchClawHubPackages({
        query: params.query,
        family,
        limit,
      }),
    ),
  );
  const byName = new Map<string, ClawHubPackageSearchResult>();
  for (const entry of groups.flat()) {
    const existing = byName.get(entry.package.name);
    if (!existing || entry.score > existing.score) {
      byName.set(entry.package.name, entry);
    }
  }
  // Stable sorting preserves family query order when ClawHub scores tie.
  return [...byName.values()].toSorted((left, right) => right.score - left.score).slice(0, limit);
}
