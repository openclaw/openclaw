import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Metadata from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import type { PluginWebFetchProviderEntry, PluginWebSearchProviderEntry } from "./types.js";
import type * as Explicit from "./web-provider-public-artifacts.explicit.js";

const mocks = vi.hoisted(() => ({
  loadMetadata: vi.fn<typeof Metadata.loadPluginMetadataSnapshot>(),
  resolveMetadata: vi.fn<typeof Metadata.resolvePluginMetadataSnapshot>(),
  loadSearch: vi.fn<typeof Explicit.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts>(),
  loadFetch: vi.fn<typeof Explicit.resolveBundledExplicitWebFetchProvidersFromPublicArtifacts>(),
  readBundledDiscoveryModeMemoized:
    vi.fn<typeof import("./bundled-discovery-state.js").readBundledDiscoveryModeMemoized>(),
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: mocks.loadMetadata,
  resolvePluginMetadataSnapshot: mocks.resolveMetadata,
}));

vi.mock("./bundled-discovery-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bundled-discovery-state.js")>()),
  readBundledDiscoveryModeMemoized: mocks.readBundledDiscoveryModeMemoized,
}));

vi.mock("./web-provider-resolution-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./web-provider-resolution-shared.js")>()),
  resolveBundledWebProviderResolutionConfig: (params: { config?: unknown }) => ({
    config: params.config,
  }),
}));

// mock-isolation: Fallback routing supplies explicit-provider results without loading plugins.
vi.mock("./web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: mocks.loadSearch,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: mocks.loadFetch,
}));

const {
  resolveBundledWebFetchProvidersFromPublicArtifacts: resolveFetch,
  resolveBundledWebSearchProvidersFromPublicArtifacts: resolveSearch,
} = await import("./web-provider-public-artifacts.js");
const { loadSearch, loadFetch } = mocks;

function createProvider(pluginId: string, id = pluginId) {
  return {
    id,
    pluginId,
    label: id,
    hint: `${id} fixture`,
    envVars: [],
    placeholder: "fixture-key",
    signupUrl: "https://example.com",
    credentialPath: `plugins.entries.${pluginId}.config.apiKey`,
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    createTool: () => null,
  } satisfies PluginWebSearchProviderEntry & PluginWebFetchProviderEntry;
}

const searchProvider = createProvider("fallback-search");
const fetchProvider = createProvider("fallback-fetch");
const env = { OPENCLAW_STATE_DIR: "/tmp/web-provider-profile" };
const snapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    { id: "fallback-search", contracts: { webSearchProviders: ["fallback-search"] } },
    { id: "fallback-fetch", contracts: { webFetchProviders: ["fallback-fetch"] } },
  ],
});

function expectLoad(
  load: typeof loadSearch | typeof loadFetch,
  onlyPluginIds: string[],
  manifestRecords?: typeof snapshot.plugins,
) {
  expect(load).toHaveBeenCalledExactlyOnceWith({ onlyPluginIds, env, manifestRecords });
}

describe("web provider public artifact manifest fallback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.readBundledDiscoveryModeMemoized.mockReturnValue("allowlist");
    mocks.loadMetadata.mockReturnValue(snapshot);
    mocks.resolveMetadata.mockImplementation((params) => mocks.loadMetadata(params));
    loadSearch.mockReturnValue([searchProvider]);
    loadFetch.mockReturnValue([fetchProvider]);
  });

  it.each(["allowlist", "compat"] as const)("resolves named search with %s discovery", (mode) => {
    const compat = mode === "compat";
    mocks.readBundledDiscoveryModeMemoized.mockReturnValue(mode);
    const providers = resolveSearch({
      config: { plugins: { allow: [compat ? "some-other-plugin" : "fallback-search"] } },
      onlyPluginIds: compat ? ["fallback-search"] : ["blocked-search", "fallback-search"],
      env,
    });

    expect(providers).toEqual([searchProvider]);
    expect(mocks.readBundledDiscoveryModeMemoized).toHaveBeenCalledWith(env);
    expect(mocks.loadMetadata).not.toHaveBeenCalled();
    expectLoad(loadSearch, ["fallback-search"]);
  });

  it("retries a named miss through the same batch with discovered owners", () => {
    loadSearch.mockReturnValueOnce(null);

    const providers = resolveSearch({ config: {}, onlyPluginIds: ["fallback-search"], env });

    expect(providers).toEqual([searchProvider]);
    expect(mocks.loadMetadata).toHaveBeenCalledOnce();
    expect(loadSearch.mock.calls).toEqual([
      [{ onlyPluginIds: ["fallback-search"], env, manifestRecords: undefined }],
      [{ onlyPluginIds: ["fallback-search"], env, manifestRecords: snapshot.plugins }],
    ]);
  });

  it.each(["fetch allowlist", "search alias"] as const)(
    "filters manifest candidates by %s",
    (kind) => {
      const fetch = kind === "fetch allowlist";
      const provider = fetch ? fetchProvider : createProvider("google", "gemini");
      const contract = fetch ? "webFetchProviders" : "webSearchProviders";
      const manifest = createPluginMetadataSnapshotFixture({
        plugins: [
          ...(fetch ? [{ id: "blocked-fetch", contracts: { [contract]: ["blocked-fetch"] } }] : []),
          { id: provider.pluginId, contracts: { [contract]: [provider.id] } },
        ],
      });
      mocks.loadMetadata.mockReturnValueOnce(manifest);
      const load = fetch ? loadFetch : loadSearch;
      load.mockReturnValueOnce([provider]);
      const resolve = fetch ? resolveFetch : resolveSearch;
      expect(
        resolve({
          config: { plugins: { allow: [fetch ? "fallback-fetch" : "google-gemini-cli"] } },
          env,
        }),
      ).toEqual([provider]);
      expectLoad(load, [provider.pluginId], manifest.plugins);
    },
  );
});
