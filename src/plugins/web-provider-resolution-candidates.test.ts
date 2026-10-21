import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveManifestDeclaredWebProviderCandidatePluginIds } from "./web-provider-resolution-shared.js";

const mocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshot: vi.fn(),
  loadPluginManifestRegistryForInstalledIndex: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshot: (...args: unknown[]) => mocks.loadPluginRegistrySnapshot(...args),
  loadPluginManifestRegistryForPluginRegistry: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryForInstalledIndex({
      ...(args[0] && typeof args[0] === "object" ? args[0] : {}),
      index: mocks.loadPluginRegistrySnapshot(...args),
    }),
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryForInstalledIndex(...args),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.loadPluginMetadataSnapshot(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) =>
    mocks.resolvePluginMetadataSnapshot(...args),
}));

describe("resolveManifestDeclaredWebProviderCandidatePluginIds", () => {
  const resolve = (params: { onlyPluginIds?: string[]; origin?: "bundled" } = {}) =>
    resolveManifestDeclaredWebProviderCandidatePluginIds({
      contract: "webSearchProviders",
      configKey: "webSearch",
      ...params,
    });

  beforeEach(() => {
    mocks.loadPluginRegistrySnapshot.mockReset().mockReturnValue({ plugins: [] });
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReset().mockReturnValue({
      plugins: [
        { id: "alpha", origin: "bundled", configSchema: { properties: { webSearch: {} } } },
        { id: "beta", origin: "bundled", contracts: { webSearchProviders: ["beta-search"] } },
      ],
      diagnostics: [],
    });
    mocks.loadPluginMetadataSnapshot.mockReset().mockImplementation((...args: unknown[]) => ({
      plugins: mocks.loadPluginManifestRegistryForInstalledIndex(...args).plugins,
    }));
    mocks.resolvePluginMetadataSnapshot.mockReset().mockImplementation((...args: unknown[]) => ({
      plugins: mocks.loadPluginManifestRegistryForInstalledIndex(...args).plugins,
    }));
  });

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(resolve({ onlyPluginIds: [] })).toStrictEqual([]);
    expect(mocks.loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });

  it("keeps scoped plugins with no declared web candidates scoped-empty", () => {
    expect(resolve({ onlyPluginIds: ["missing-plugin"] })).toStrictEqual([]);
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps origin filters with no declared web candidates scoped-empty", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [{ id: "workspace-tool", origin: "workspace", configSchema: { properties: {} } }],
      diagnostics: [],
    });

    expect(resolve({ origin: "bundled" })).toStrictEqual([]);
  });

  it("limits sandboxed web fetch candidates to bundled and trusted official installs", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        ["bundled-fetch", "bundled", false],
        ["firecrawl", "global", true],
        ["third-party-fetch", "global", false],
        ["workspace-fetch", "workspace", false],
      ].map(([id, origin, trustedOfficialInstall]) => ({
        id,
        origin,
        trustedOfficialInstall,
        contracts: { webFetchProviders: [id] },
      })),
      diagnostics: [],
    });

    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webFetchProviders",
        configKey: "webFetch",
        sandboxed: true,
      }),
    ).toEqual(["bundled-fetch", "firecrawl"]);
  });

  it("derives provider candidates from a single manifest-registry read", () => {
    expect(resolve()).toEqual(["alpha", "beta"]);
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(1);
  });
});
