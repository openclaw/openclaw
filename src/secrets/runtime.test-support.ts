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
import { buildTestWebSearchProviders as baseProviders } from "./runtime-web-tools-provider.test-support.js";
// Keep static: compiled-worker preparation belongs at collection, not in a hook or test deadline.
import { clearSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } from "./runtime.js";

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

export function buildTestWebSearchProviders(): PluginWebSearchProviderEntry[] {
  return baseProviders()
    .filter(({ id }) => id !== "duckduckgo")
    .map((provider) => {
      const { id } = provider;
      return Object.assign(provider, {
        getCredentialValue: (searchConfig) => {
          const candidate = searchConfig?.[id];
          const providerConfig =
            candidate && typeof candidate === "object"
              ? (candidate as { apiKey?: unknown })
              : undefined;
          return providerConfig?.apiKey ?? searchConfig?.apiKey;
        },
        setCredentialValue: (searchConfigTarget, value) => {
          const providerConfig =
            id === "brave"
              ? searchConfigTarget
              : ((searchConfigTarget[id] ??= {}) as { apiKey?: unknown });
          providerConfig.apiKey = value;
        },
        getConfiguredCredentialFallback:
          id === "gemini" ? provider.getConfiguredCredentialFallback : undefined,
      } satisfies Partial<PluginWebSearchProviderEntry>);
    });
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
