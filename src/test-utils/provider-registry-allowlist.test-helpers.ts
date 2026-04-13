import { beforeEach, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";

const providerRegistryAllowlistMocks = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn<
    (params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined
  >(() => undefined),
  loadPluginManifestRegistry: vi.fn(() => ({ plugins: [], diagnostics: [] })),
  withBundledPluginEnablementCompat: vi.fn(({ config }) => config),
  withBundledPluginVitestCompat: vi.fn(({ config }) => config),
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: providerRegistryAllowlistMocks.resolveRuntimePluginRegistry,
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: providerRegistryAllowlistMocks.loadPluginManifestRegistry,
}));

vi.mock("../plugins/bundled-compat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/bundled-compat.js")>();
  return {
    ...actual,
    withBundledPluginEnablementCompat:
      providerRegistryAllowlistMocks.withBundledPluginEnablementCompat,
    withBundledPluginVitestCompat: providerRegistryAllowlistMocks.withBundledPluginVitestCompat,
  };
});

export function getProviderRegistryAllowlistMocks(): typeof providerRegistryAllowlistMocks {
  return providerRegistryAllowlistMocks;
}

export function createEmptyProviderRegistryAllowlistFallbackRegistry(): ReturnType<
  typeof createEmptyPluginRegistry
> {
  return createEmptyPluginRegistry();
}

export function installProviderRegistryAllowlistMockDefaults(): void {
  beforeEach(() => {
    providerRegistryAllowlistMocks.resolveRuntimePluginRegistry.mockReset();
    providerRegistryAllowlistMocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    providerRegistryAllowlistMocks.loadPluginManifestRegistry.mockReset();
    providerRegistryAllowlistMocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    providerRegistryAllowlistMocks.withBundledPluginEnablementCompat.mockReset();
    providerRegistryAllowlistMocks.withBundledPluginEnablementCompat.mockImplementation(
      ({ config }) => config,
    );
    providerRegistryAllowlistMocks.withBundledPluginVitestCompat.mockReset();
    providerRegistryAllowlistMocks.withBundledPluginVitestCompat.mockImplementation(
      ({ config }) => config,
    );
  });
}
