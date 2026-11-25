import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  vi.fn<(params: { dirName: string; artifactCandidates: readonly string[] }) => object | null>(),
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

afterEach(() => expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled());
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
  expect(resolveSearch({ onlyPluginIds: ["mockplugin"] })).toEqual([
    expect.objectContaining({ pluginId: "mockplugin", id: "mockplugin" }),
  ]);
  expect(warn).toHaveBeenCalledOnce();
});

it("throws when every matching bundled web provider factory fails", () => {
  expect(() => resolveSearch({ onlyPluginIds: ["fuzzplugin"] })).toThrow(
    "Unable to initialize web providers for plugin fuzzplugin",
  );
  expect(warn).not.toHaveBeenCalled();
});

it.each([
  { resolve: resolveFetch, artifact: "web-fetch-contract-api.js", executable: false },
  { resolve: resolveRuntimeFetch, artifact: "web-fetch-provider.js", executable: true },
])("resolves explicit $artifact without manifest scans", ({ resolve, executable }) => {
  const providers = resolve({ onlyPluginIds: ["firecrawl"] });
  expect(providers).toEqual([expect.objectContaining({ pluginId: "firecrawl" })]);
  const tool = providers?.[0]?.createTool({ config: {} as never });
  if (!executable) {
    expect(tool).toBeNull();
    return;
  }
  expect(tool).not.toBeNull();
  expect(loadCandidates.mock.calls.flatMap(([params]) => params.artifactCandidates)).not.toContain(
    "web-fetch-contract-api.js",
  );
});
