/** Shared fixtures for secrets runtime unit tests. */
import { afterEach, beforeEach, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
// Keep static: compiled-worker preparation belongs at collection, not in a hook or test deadline.
import { clearSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } from "./runtime.js";

type WebProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecordsSync: () => ({}),
}));

export function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

export function loadAuthStoreWithProfiles(
  profiles: AuthProfileStore["profiles"],
): AuthProfileStore {
  return { version: 1, profiles };
}

function createTestProvider(
  id: WebProviderUnderTest,
  pluginId: string,
  autoDetectOrder: number,
): PluginWebSearchProviderEntry {
  const credentialPath = `plugins.entries.${pluginId}.config.webSearch.apiKey`;
  return {
    pluginId,
    id,
    label: id,
    hint: `${id} test provider`,
    envVars: [`${id.toUpperCase()}_API_KEY`],
    placeholder: `${id}-...`,
    signupUrl: `https://example.com/${id}`,
    autoDetectOrder,
    credentialPath,
    inactiveSecretPaths: [credentialPath],
    getCredentialValue: (searchConfig) => {
      const provider = searchConfig?.[id];
      const providerConfig =
        provider && typeof provider === "object" ? (provider as { apiKey?: unknown }) : undefined;
      return providerConfig?.apiKey ?? searchConfig?.apiKey;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const providerConfig =
        id === "brave"
          ? searchConfigTarget
          : ((searchConfigTarget[id] ??= {}) as { apiKey?: unknown });
      providerConfig.apiKey = value;
    },
    getConfiguredCredentialValue: (config) =>
      (config?.plugins?.entries?.[pluginId]?.config as { webSearch?: { apiKey?: unknown } })
        ?.webSearch?.apiKey,
    getConfiguredCredentialFallback:
      id === "gemini"
        ? (config) => {
            const provider = (config?.models?.providers?.google ?? {}) as { apiKey?: unknown };
            return provider.apiKey !== undefined
              ? { path: "models.providers.google.apiKey", value: provider.apiKey }
              : undefined;
          }
        : undefined,
    setConfiguredCredentialValue: (configTarget, value) => {
      const plugins = (configTarget.plugins ??= {}) as { entries?: Record<string, unknown> };
      const entries = (plugins.entries ??= {});
      const entry = (entries[pluginId] ??= {}) as { config?: Record<string, unknown> };
      const config = (entry.config ??= {});
      const webSearch = (config.webSearch ??= {}) as { apiKey?: unknown };
      webSearch.apiKey = value;
    },
    resolveRuntimeMetadata:
      id === "perplexity" ? () => ({ perplexityTransport: "search_api" as const }) : undefined,
    createTool: () => null,
  };
}

export function buildTestWebSearchProviders(): PluginWebSearchProviderEntry[] {
  return [
    createTestProvider("brave", "brave", 10),
    createTestProvider("gemini", "google", 20),
    createTestProvider("grok", "xai", 30),
    createTestProvider("kimi", "moonshot", 40),
    createTestProvider("perplexity", "perplexity", 50),
  ];
}

export function resetPluginWebSearchProvidersMock() {
  resolvePluginWebSearchProvidersMock.mockReset();
  resolvePluginWebSearchProvidersMock.mockReturnValue(buildTestWebSearchProviders());
}

export function setupSecretsRuntimeSnapshotTestHooks(): {
  prepareSecretsRuntimeSnapshot: typeof prepareSecretsRuntimeSnapshot;
} {
  beforeEach(resetPluginWebSearchProvidersMock);

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  return { prepareSecretsRuntimeSnapshot };
}
