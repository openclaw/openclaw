// Plugin config runtime helpers load and normalize plugin-owned configuration at execution time.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizePluginsConfig as readNormalizedPluginsConfig } from "../plugins/config-state.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../shared/immutable-data.js";

export {
  createNormalizedPluginsConfig as normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "../plugins/config-state.js";
export { mergeDeep } from "../infra/deep-merge.js";

/** Reuse a pure parser's owned JSON result for one published or immutable config revision. */
export function createPluginConfigParser<T>(
  pluginId: string,
  parse: (value: unknown) => T,
): (value: unknown) => T {
  const parsed = new WeakMap<object, { revision: object | undefined; value: T }>();
  return (value) => {
    if (!value || typeof value !== "object") {
      return parse(value);
    }
    const current = runtimeConfigPublication.current;
    const revision =
      current && resolvePluginConfigObject(current.config, pluginId) === value
        ? current.revision
        : undefined;
    if (!revision && !isDeeplyFrozenPlainData(value)) {
      return parse(value);
    }
    const cached = parsed.get(value);
    if (cached && cached.revision === revision) {
      return cached.value;
    }
    const result = freezeJsonSnapshot(parse(value));
    parsed.set(value, { revision, value: result });
    return result;
  };
}

/** Requires an already-resolved runtime config at plugin runtime boundaries. */
export function requireRuntimeConfig(config: OpenClawConfig, context: string): OpenClawConfig {
  if (config) {
    return config;
  }
  throw new Error(
    `${context} requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.`,
  );
}

/** Reads a plugin's object-shaped `plugins.entries[id].config` block from resolved config. */
export function resolvePluginConfigObject(
  config: OpenClawConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const plugins = readNormalizedPluginsConfig(config?.plugins);
  const pluginConfig = plugins.entries[pluginId]?.config;
  return asOptionalRecord(pluginConfig);
}

/** Resolves live plugin config through a loader, falling back to startup config when unavailable. */
export function resolveLivePluginConfigObject(
  runtimeConfigLoader: (() => OpenClawConfig | undefined) | undefined,
  pluginId: string,
  startupPluginConfig?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof runtimeConfigLoader !== "function") {
    return startupPluginConfig;
  }
  return resolvePluginConfigObject(runtimeConfigLoader(), pluginId);
}
