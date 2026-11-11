import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";
import type * as Metadata from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import type * as Explicit from "./web-provider-public-artifacts.explicit.js";
import { resolveManifestDeclaredWebProviderCandidatePluginIds as resolveCandidates } from "./web-provider-resolution-shared.js";

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
  return createWebSearchTestProvider({
    pluginId,
    id,
    credentialPath: `plugins.entries.${pluginId}.config.apiKey`,
    createTool: () => null,
  });
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

describe("manifest-declared web candidates", () => {
  const resolve = (params: { onlyPluginIds?: string[]; origin?: "bundled" } = {}) =>
    resolveCandidates({ contract: "webSearchProviders", configKey: "webSearch", ...params });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveMetadata.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          { id: "alpha", origin: "workspace", configSchema: { properties: { webSearch: {} } } },
          { id: "beta", origin: "workspace", contracts: { webSearchProviders: ["beta-search"] } },
        ],
      }),
    );
  });
  it.each([{ onlyPluginIds: [] }, { onlyPluginIds: ["missing-plugin"] }])(
    "keeps explicit scope $onlyPluginIds empty",
    ({ onlyPluginIds }) => {
      expect(resolve({ onlyPluginIds })).toStrictEqual([]);
      if (onlyPluginIds.length === 0) {
        expect(mocks.resolveMetadata).not.toHaveBeenCalled();
        expect(mocks.loadMetadata).not.toHaveBeenCalled();
      }
    },
  );
  it("keeps unmatched origin filters scoped-empty", () => {
    expect(resolve({ origin: "bundled" })).toStrictEqual([]);
  });
  it("limits sandboxed fetch to bundled and trusted official installs", () => {
    mocks.resolveMetadata.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: (
          [
            ["bundled-fetch", "bundled", false],
            ["firecrawl", "global", true],
            ["third-party-fetch", "global", false],
            ["workspace-fetch", "workspace", false],
          ] as const
        ).map(([id, origin, trustedOfficialInstall]) => ({
          id,
          origin,
          trustedOfficialInstall,
          contracts: { webFetchProviders: [id] },
        })),
      }),
    );
    expect(
      resolveCandidates({ contract: "webFetchProviders", configKey: "webFetch", sandboxed: true }),
    ).toEqual(["bundled-fetch", "firecrawl"]);
  });
  it("derives candidates from config and contract declarations", () => {
    expect(resolve()).toEqual(["alpha", "beta"]);
  });
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
    expect(mocks.loadMetadata).not.toHaveBeenCalled();
    expectLoad(loadSearch, ["fallback-search"]);
  });

  it("retries a named miss through the same batch with discovered owners", () => {
    loadSearch.mockReturnValueOnce(null);

    expect(resolveSearch({ config: {}, onlyPluginIds: ["fallback-search"], env })).toEqual([
      searchProvider,
    ]);
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
