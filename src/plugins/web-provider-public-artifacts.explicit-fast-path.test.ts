import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { loadCandidates, loadArtifact } = vi.hoisted(() => {
  const providerBase = {
    label: "Fixture",
    hint: "fixture",
    envVars: ["FIXTURE_API_KEY"],
    placeholder: "fixture",
    signupUrl: "https://example.com",
    credentialPath: "plugins.entries.fixture.config.apiKey",
    getCredentialValue: () => undefined,
    setCredentialValue: () => ({}),
  };
  const failedFactory = () => {
    throw new Error("fuzzplugin web provider factory failed");
  };
  const provider = (id: string) => ({ ...providerBase, id, createTool: () => null });
  const searchFactories = { createFuzzpluginWebSearchProvider: failedFactory };
  const modules: Record<string, object> = {
    "mockplugin/web-search-contract-api.js": {
      ...searchFactories,
      createMockpluginWebSearchProvider: () => provider("mockplugin"),
    },
    "fuzzplugin/web-search-contract-api.js": searchFactories,
    "firecrawl/web-fetch-contract-api.js": {
      createFirecrawlWebFetchProvider: () => provider("firecrawl"),
    },
    "firecrawl/web-fetch-provider.js": {
      createFirecrawlWebFetchProvider: () => ({
        ...provider("firecrawl"),
        createTool: () => ({
          description: "runtime firecrawl",
          parameters: {},
          execute: async () => ({}),
        }),
      }),
    },
  };
  const lowLevelLoaderMock = vi.fn(
    ({ dirName, artifactBasename }: { dirName: string; artifactBasename: string }) => {
      return expectDefined(modules[`${dirName}/${artifactBasename}`], "Unexpected fixture module");
    },
  );
  return {
    loadArtifact: lowLevelLoaderMock,
    loadCandidates: vi.fn(
      ({
        dirName,
        artifactCandidates,
      }: {
        dirName: string;
        artifactCandidates: readonly string[];
      }) => {
        const artifactBasename = artifactCandidates.find((name) =>
          Object.hasOwn(modules, `${dirName}/${name}`),
        );
        return artifactBasename ? lowLevelLoaderMock({ dirName, artifactBasename }) : null;
      },
    ),
  };
});

vi.mock("./manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest-registry.js")>()),
  loadPluginManifestRegistryCore: loadPluginManifestRegistryMock,
}));

vi.mock("./public-surface-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./public-surface-loader.js")>()),
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadCandidates,
  loadBundledPluginPublicArtifactModuleSync: loadArtifact,
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
  expect(loadArtifact).toHaveBeenCalledWith({
    dirName,
    artifactBasename,
  });
  expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
}

describe("web provider public artifacts explicit fast path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(loadArtifact).not.toHaveBeenCalledWith({
      dirName: "firecrawl",
      artifactBasename: "web-fetch-contract-api.js",
    });
  });
});
