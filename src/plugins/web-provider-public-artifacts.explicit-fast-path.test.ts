import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off the explicit bundled fast path");
  }),
}));

const loadCandidates = vi.hoisted(() =>
  vi.fn<
    ({
      dirName,
      artifactCandidates,
    }: {
      dirName: string;
      artifactCandidates: readonly string[];
    }) => object | null
  >(),
);

vi.mock("./manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest-registry.js")>()),
  loadPluginManifestRegistryCore: loadPluginManifestRegistryMock,
}));

vi.mock("./public-surface-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./public-surface-loader.js")>()),
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadCandidates,
}));

import { resolveBundledExplicitRuntimeWebFetchProvidersFromPublicArtifacts as resolveRuntimeFetch } from "./web-provider-public-artifacts.explicit.js";
import {
  resolveBundledWebFetchProvidersFromPublicArtifacts as resolveFetch,
  resolveBundledWebSearchProvidersFromPublicArtifacts as resolveSearch,
} from "./web-provider-public-artifacts.js";

function expectSingleProvider<T extends { pluginId: string }>(
  resolve: (params: { onlyPluginIds: string[] }) => T[] | null,
  pluginId: string,
  artifactBasename: string,
): T {
  const providers = resolve({ onlyPluginIds: [pluginId] });
  expect(providers).toHaveLength(1);
  const provider = expectDefined(providers?.[0], "Expected one web provider");
  expect(provider.pluginId).toBe(pluginId);
  expectArtifact(pluginId, artifactBasename);
  return provider;
}

function expectArtifact(dirName: string, artifactBasename: string) {
  expect(loadCandidates).toHaveBeenCalledWith(
    expect.objectContaining({
      dirName,
      artifactCandidates: expect.arrayContaining([artifactBasename]),
    }),
  );
  expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
}

describe("web provider public artifacts explicit fast path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const makeProvider = (id: string, executable = false) =>
      createWebSearchTestProvider({
        pluginId: id,
        id,
        credentialPath: "plugins.entries.fixture.config.apiKey",
        ...(executable ? {} : { createTool: () => null }),
      });
    const searchFactories = {
      createFuzzpluginWebSearchProvider: () => {
        throw new Error("fuzzplugin web provider factory failed");
      },
    };
    const modules: Record<string, object> = {
      "mockplugin/web-search-contract-api.js": {
        ...searchFactories,
        createMockpluginWebSearchProvider: () => makeProvider("mockplugin"),
      },
      "fuzzplugin/web-search-contract-api.js": searchFactories,
      "firecrawl/web-fetch-contract-api.js": {
        createFirecrawlWebFetchProvider: () => makeProvider("firecrawl"),
      },
      "firecrawl/web-fetch-provider.js": {
        createFirecrawlWebFetchProvider: () => makeProvider("firecrawl", true),
      },
    };
    loadCandidates.mockImplementation(
      ({ dirName, artifactCandidates }) =>
        artifactCandidates.map((name) => modules[`${dirName}/${name}`]).find(Boolean) ?? null,
    );
  });

  it("skips throwing bundled web provider factories while preserving healthy siblings", () => {
    const provider = expectSingleProvider(
      resolveSearch,
      "mockplugin",
      "web-search-contract-api.js",
    );

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/web providers.*mockplugin/),
      { error: expect.objectContaining({ message: "fuzzplugin web provider factory failed" }) },
    );
    expect(provider.id).toBe("mockplugin");
    expect(provider.createTool({ config: {} as never })).toBeNull();
  });

  it("throws when every matching bundled web provider factory fails", () => {
    expect(() =>
      resolveSearch({
        onlyPluginIds: ["fuzzplugin"],
      }),
    ).toThrow("Unable to initialize web providers for plugin fuzzplugin");
    expect(warn).not.toHaveBeenCalled();

    expectArtifact("fuzzplugin", "web-search-contract-api.js");
  });

  it.each([
    { resolve: resolveFetch, artifact: "web-fetch-contract-api.js", executable: false },
    { resolve: resolveRuntimeFetch, artifact: "web-fetch-provider.js", executable: true },
  ])("resolves explicit $artifact without manifest scans", ({ resolve, artifact, executable }) => {
    const provider = expectSingleProvider(resolve, "firecrawl", artifact);
    const tool = provider.createTool({ config: {} as never });
    if (!executable) {
      expect(tool).toBeNull();
      return;
    }
    expect(tool).not.toBeNull();
    expect(
      loadCandidates.mock.calls.flatMap(([params]) => params.artifactCandidates),
    ).not.toContain("web-fetch-contract-api.js");
  });
});
