import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getActivePluginRegistryVersion } from "../plugins/runtime.js";
import {
  collectChannelSchemaMetadataCore,
  collectPluginSchemaMetadataCore,
} from "./channel-config-metadata.js";
import { resolveChannelSchemaSelection } from "./channel-schema-selection.js";
import { getRuntimeConfig, readConfigFileSnapshot } from "./config.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./config.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import {
  buildConfigRedactionHints,
  buildConfigSchemaCore,
  type ConfigSchemaResponse,
} from "./schema.js";

/** Builds one config schema from an exact manifest registry. */
export function buildRuntimeConfigSchemaFromRegistry(
  registry: PluginManifestRegistry,
  config: OpenClawConfig,
): ConfigSchemaResponse {
  return buildConfigSchemaCore(collectRuntimeSchemaMetadata(registry, config));
}

function collectRuntimeSchemaMetadata(registry: PluginManifestRegistry, config: OpenClawConfig) {
  return {
    plugins: collectPluginSchemaMetadataCore(registry),
    channels: collectChannelSchemaMetadataCore(
      registry,
      resolveChannelSchemaSelection(registry, config),
    ),
  };
}

let gatewaySchemaCache: {
  config: OpenClawConfig;
  pluginRegistryVersion: number;
  metadata: ReturnType<typeof collectRuntimeSchemaMetadata>;
  response?: ConfigSchemaResponse;
  redactionHints?: ConfigSchemaResponse["uiHints"];
} | null = null;

export function invalidateGatewayRuntimeConfigSchema(): void {
  gatewaySchemaCache = null;
}

/** RPC and document readers share metadata for one prepared config and plugin generation. */
function loadGatewaySchemaMetadata(config: OpenClawConfig) {
  const pluginRegistryVersion = getActivePluginRegistryVersion();
  if (
    gatewaySchemaCache?.config === config &&
    gatewaySchemaCache.pluginRegistryVersion === pluginRegistryVersion
  ) {
    return gatewaySchemaCache;
  }
  const registry = resolveConfigWidePluginManifestRegistry({ config, env: process.env });
  gatewaySchemaCache = {
    config,
    pluginRegistryVersion,
    metadata: collectRuntimeSchemaMetadata(registry, config),
  };
  return gatewaySchemaCache;
}

export function loadGatewayRuntimeConfigSchema(config = getRuntimeConfig()): ConfigSchemaResponse {
  const cached = loadGatewaySchemaMetadata(config);
  return (cached.response ??= buildConfigSchemaCore(cached.metadata));
}

export function loadGatewayConfigRedactionHints(
  config = getRuntimeConfig(),
): ConfigSchemaResponse["uiHints"] {
  const cached = loadGatewaySchemaMetadata(config);
  return (cached.redactionHints ??=
    cached.response?.uiHints ?? buildConfigRedactionHints(cached.metadata));
}

export async function readBestEffortRuntimeConfigSchema(prepared?: {
  snapshot: ConfigFileSnapshot;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}): Promise<ConfigSchemaResponse> {
  const snapshot = prepared?.snapshot ?? (await readConfigFileSnapshot({ observe: false }));
  const config = snapshot.valid
    ? snapshot.sourceConfig
    : { agents: { entries: { main: {} } }, plugins: { enabled: true } };
  const registry =
    (snapshot.valid ? prepared?.pluginMetadataSnapshot?.manifestRegistry : undefined) ??
    resolveConfigWidePluginManifestRegistry({ config, env: process.env });
  if (snapshot.valid) {
    return buildRuntimeConfigSchemaFromRegistry(registry, config);
  }
  return buildConfigSchemaCore({
    plugins: [],
    channels: collectChannelSchemaMetadataCore(
      registry,
      resolveChannelSchemaSelection(registry, config),
    ),
  });
}
