/** Runtime facade used by docs baseline generation to keep imports narrow. */
export { collectBundledChannelConfigsCore as collectBundledChannelConfigs } from "../plugins/bundled-channel-config-metadata.js";
export { loadPluginManifestRegistryCore as loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
export {
  collectChannelSchemaMetadataCore as collectChannelSchemaMetadata,
  collectPluginSchemaMetadataCore as collectPluginSchemaMetadata,
} from "./channel-config-metadata.js";
export { buildConfigSchemaCore as buildConfigSchema } from "./schema.js";
