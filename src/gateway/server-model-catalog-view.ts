import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PreparedGatewayModelCatalog } from "./server-model-catalog.types.js";

// Captured facts follow their view's lifetime without widening the public Gateway context.
const metadataByCatalog = new WeakMap<PreparedGatewayModelCatalog, PluginMetadataSnapshot>();

export function createPreparedGatewayModelCatalog(
  params: PreparedGatewayModelCatalog & { metadataSnapshot?: PluginMetadataSnapshot },
): PreparedGatewayModelCatalog {
  const catalog: PreparedGatewayModelCatalog = {
    entries: params.entries,
    routeVariants: params.routeVariants,
    pluginRegistry: params.pluginRegistry,
  };
  if (params.metadataSnapshot) {
    metadataByCatalog.set(catalog, params.metadataSnapshot);
  }
  return catalog;
}

export function readPreparedGatewayModelCatalogMetadata(
  catalog: PreparedGatewayModelCatalog | undefined,
): PluginMetadataSnapshot | undefined {
  return catalog ? metadataByCatalog.get(catalog) : undefined;
}
