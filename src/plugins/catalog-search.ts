// ClawHub owns ranking and limiting the combined installable plugin response.
import type { PluginsSearchParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { fetchClawHubJson, isClawHubTelemetryDisabled } from "../infra/clawhub-client.js";
import type { ClawHubPackageSearchResult } from "../infra/clawhub-packages.js";

const DEFAULT_PLUGIN_SEARCH_LIMIT = 20;
const MAX_PLUGIN_SEARCH_LIMIT = 100;

function resolveSearchLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return DEFAULT_PLUGIN_SEARCH_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PLUGIN_SEARCH_LIMIT);
}

/** Returns the exact combined ClawHub response without family fan-out or reranking. */
export async function searchInstallablePluginPackages(
  params: PluginsSearchParams,
): Promise<ClawHubPackageSearchResult[]> {
  const searchSource = isClawHubTelemetryDisabled() ? undefined : params.searchSource;
  const result = await fetchClawHubJson<{ results: ClawHubPackageSearchResult[] }>({
    path: "/api/v1/plugins/search",
    // A completed marked read records demand; replaying it could count twice.
    retryTransientReads: searchSource === undefined,
    search: {
      q: params.query.trim(),
      limit: String(resolveSearchLimit(params.limit)),
      searchSource,
    },
  });
  return result.results ?? [];
}
