import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isLegacyWebSearchProviderConfigKey } from "../../config/web-search-legacy-provider-keys.js";

export { resolvePluginWebSearchConfig as resolveProviderWebSearchPluginConfig } from "../../config/plugin-web-search-config.js";

export function getTopLevelCredentialValue(searchConfig?: Record<string, unknown>): unknown {
  return searchConfig?.apiKey;
}

export function setTopLevelCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  value: unknown,
): void {
  searchConfigTarget.apiKey = value;
}

export function getScopedCredentialValue(
  searchConfig: Record<string, unknown> | undefined,
  key: string,
): unknown {
  return asOptionalRecord(searchConfig?.[key])?.apiKey;
}

export function setScopedCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const scoped = asOptionalRecord(searchConfigTarget[key]);
  if (!scoped) {
    searchConfigTarget[key] = { apiKey: value };
    return;
  }
  scoped.apiKey = value;
}

/** Projects plugin web-search config into the provider-scoped tool-local shape. */
export function mergeScopedSearchConfig(
  searchConfig: Record<string, unknown> | undefined,
  key: string,
  pluginConfig: Record<string, unknown> | undefined,
  options?: { mirrorApiKeyToTopLevel?: boolean },
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...searchConfig };
  delete next.apiKey;
  if (isLegacyWebSearchProviderConfigKey(key)) {
    delete next[key];
  }
  if (!pluginConfig) {
    return Object.keys(next).length > 0 ? next : undefined;
  }

  // Provider-local projections are runtime-only and must never reserialize into tools.web.search.
  Object.defineProperty(next, key, {
    value: { ...pluginConfig },
    enumerable: false,
    configurable: true,
    writable: true,
  });

  if (options?.mirrorApiKeyToTopLevel && pluginConfig.apiKey !== undefined) {
    next.apiKey = pluginConfig.apiKey;
  }

  return next;
}

function ensureObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = asOptionalRecord(target[key]);
  if (current) {
    return current;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

/** Writes a single plugin-owned web-search config value and enables the plugin entry if needed. */
export function setProviderWebSearchPluginConfigValue(
  configTarget: OpenClawConfig,
  pluginId: string,
  key: string,
  value: unknown,
): void {
  const plugins = ensureObject(configTarget as Record<string, unknown>, "plugins");
  const entries = ensureObject(plugins, "entries");
  const entry = ensureObject(entries, pluginId);
  if (entry.enabled === undefined) {
    entry.enabled = true;
  }
  const config = ensureObject(entry, "config");
  const webSearch = ensureObject(config, "webSearch");
  webSearch[key] = value;
}
