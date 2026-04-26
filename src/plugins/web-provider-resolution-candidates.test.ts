import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshot: vi.fn(),
  loadPluginManifestRegistryForInstalledIndex: vi.fn(),
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryForPluginRegistry(...args),
  loadPluginRegistrySnapshot: (...args: unknown[]) => mocks.loadPluginRegistrySnapshot(...args),
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryForInstalledIndex(...args),
}));

let resolveManifestDeclaredWebProviderCandidatePluginIds: typeof import("./web-provider-resolution-shared.js").resolveManifestDeclaredWebProviderCandidatePluginIds;

describe("resolveManifestDeclaredWebProviderCandidatePluginIds", () => {
  beforeAll(async () => {
    ({ resolveManifestDeclaredWebProviderCandidatePluginIds } =
      await import("./web-provider-resolution-shared.js"));
  });

  beforeEach(() => {
    mocks.loadPluginRegistrySnapshot.mockReset();
    mocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    const manifestRegistry = {
      plugins: [
        {
          id: "alpha",
          origin: "bundled",
          configSchema: {
            properties: {
              webSearch: {},
            },
          },
        },
        {
          id: "beta",
          origin: "bundled",
          contracts: {
            webSearchProviders: ["beta-search"],
          },
        },
      ],
      diagnostics: [],
    };
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue(manifestRegistry);
  });

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        onlyPluginIds: [],
      }),
    ).toEqual([]);
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).not.toHaveBeenCalled();
  });

  it("keeps runtime fallback for scoped plugins with no declared web candidates", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        onlyPluginIds: ["missing-plugin"],
      }),
    ).toBeUndefined();
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginIds: ["missing-plugin"],
      }),
    );
  });

  it("derives provider candidates from a single manifest-registry read", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
      }),
    ).toEqual(["alpha", "beta"]);
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(1);
  });
});
