import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginId, normalizePluginsConfig } from "./config-state.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { validatePluginSchemaValue } from "./schema-validator.js";

export type PluginConfigEnablement =
  | { mode: "ready" }
  | { mode: "missing" }
  | { mode: "invalid"; error: string };

export function resolvePluginConfigEnablement(params: {
  config: OpenClawConfig;
  pluginId: string;
  manifest?: PluginManifestRecord;
}): PluginConfigEnablement {
  const manifest = params.manifest;
  if (!manifest?.configSchema) {
    return { mode: "ready" };
  }
  // Settings live under the canonical lowercase policy key, not the manifest spelling.
  const settings = normalizePluginsConfig(params.config.plugins).entries[
    normalizePluginId(params.pluginId)
  ]?.config;
  const hasConfig = settings !== undefined;
  const result = validatePluginSchemaValue({
    origin: manifest.origin,
    schema: manifest.configSchema,
    cacheKey: manifest.schemaCacheKey ?? manifest.manifestPath,
    value: hasConfig ? settings : {},
    applyDefaults: true,
  });
  if (result.ok) {
    return { mode: "ready" };
  }
  // A malformed schema cannot be repaired by supplying config. Only a valid schema
  // rejecting absent config represents setup that the operator can complete.
  if (!hasConfig && !result.schemaError) {
    return { mode: "missing" };
  }
  return { mode: "invalid", error: result.errors[0]?.text ?? "invalid plugin config" };
}
