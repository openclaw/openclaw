import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { MediaUnderstandingProvider } from "./provider-types.js";

function mediaModelProviderIdentity(
  declaredId: string,
  catalog: PluginManifestRecord["modelCatalog"],
): MediaUnderstandingProvider | undefined {
  const id = normalizeProviderId(declaredId);
  if (normalizeMediaProviderId(id) === id) {
    return undefined;
  }
  const models = catalog?.providers?.[id]?.models ?? [];
  return {
    id,
    capabilities: models.some((model) => model.input?.includes("image")) ? ["image"] : [],
    inheritConfiguredImageCapability: true,
  };
}

/** Reserve model-provider names before applying historical media aliases, without loading code. */
export function buildMediaProviderIdentityRegistry(
  cfg?: OpenClawConfig,
  workspaceDir?: string,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  if (cfg?.plugins?.enabled === false) {
    return registry;
  }
  const snapshot = loadManifestMetadataSnapshot({ config: cfg, workspaceDir });
  for (const plugin of snapshot.plugins) {
    if (!isManifestPluginAvailableForControlPlane({ snapshot, plugin, config: cfg })) {
      continue;
    }
    for (const declaredId of plugin.providers) {
      const identity = mediaModelProviderIdentity(declaredId, plugin.modelCatalog);
      if (identity) {
        registry.set(identity.id, identity);
      }
    }
  }
  return registry;
}
