import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  collectChannelSchemaMetadataCore,
  collectPluginSchemaMetadataCore,
} from "./channel-config-metadata.js";
import { resolveChannelSchemaSelection } from "./channel-schema-selection.js";
import { getRuntimeConfig, readConfigFileSnapshot } from "./config.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./config.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import { buildConfigSchemaCore, type ConfigSchemaResponse } from "./schema.js";

/** Builds one config schema from an exact manifest registry. */
export function buildRuntimeConfigSchemaFromRegistry(
  registry: PluginManifestRegistry,
  config: OpenClawConfig,
): ConfigSchemaResponse {
  return buildConfigSchemaCore({
    plugins: collectPluginSchemaMetadataCore(registry),
    channels: collectChannelSchemaMetadataCore(
      registry,
      resolveChannelSchemaSelection(registry, config),
    ),
  });
}

/** Builds the config schema from the active runtime config and plugin metadata. */
export function loadGatewayRuntimeConfigSchema(): ConfigSchemaResponse {
  const config = getRuntimeConfig();
  const registry = resolveConfigWidePluginManifestRegistry({ config, env: process.env });
  return buildRuntimeConfigSchemaFromRegistry(registry, config);
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
