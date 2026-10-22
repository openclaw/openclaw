/**
 * Provider endpoint metadata for officially externalized provider plugins.
 *
 * Endpoint classification (SSRF, attribution, payload-compat policy) keys off
 * base URLs and must keep working when the owning plugin is not installed:
 * dist packages exclude externalized plugins, so their manifests are invisible
 * to bundled discovery. Only the repo-bundled catalog JSON feeds this table;
 * hosted marketplace feeds must never influence endpoint classification.
 * Kept separate from official-external-plugin-catalog.ts so provider
 * transports do not pull the ClawHub install/marketplace module graph.
 */
import officialExternalProviderCatalog from "../../scripts/lib/official-external-provider-catalog.json" with { type: "json" };
import { MANIFEST_KEY } from "../compat/legacy-names.js";

/**
 * Lists manifest-shaped catalog metadata blocks that declare provider endpoints.
 *
 * The catalog mirrors manifests faithfully, including endpoint classes core
 * does not (yet) recognize (e.g. deepinfra-native, gmi-native). The endpoint
 * reader filters unknown classes exactly as it does for installed manifests,
 * so they stay inert instead of complicating the mirror contract.
 */
export function listOfficialExternalProviderEndpointManifests(): Record<string, unknown>[] {
  return officialExternalProviderCatalog.entries.flatMap((entry) => {
    const manifest = entry[MANIFEST_KEY];
    return manifest.providerEndpoints ? [manifest] : [];
  });
}
