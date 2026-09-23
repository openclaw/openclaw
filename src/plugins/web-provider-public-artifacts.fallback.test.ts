/** Tests web provider fallback loading from bundled public artifacts. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import type { PluginWebFetchProviderEntry, PluginWebSearchProviderEntry } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot:
    vi.fn<typeof import("./plugin-metadata-snapshot.js").loadPluginMetadataSnapshot>(),
  resolvePluginMetadataSnapshot:
    vi.fn<typeof import("./plugin-metadata-snapshot.js").resolvePluginMetadataSnapshot>(),
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts:
    vi.fn<
      typeof import("./web-provider-public-artifacts.explicit.js").resolveBundledExplicitWebSearchProvidersFromPublicArtifacts
    >(),
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts:
    vi.fn<
      typeof import("./web-provider-public-artifacts.explicit.js").resolveBundledExplicitWebFetchProvidersFromPublicArtifacts
    >(),
  readBundledDiscoveryModeMemoized:
    vi.fn<typeof import("./bundled-discovery-state.js").readBundledDiscoveryModeMemoized>(),
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
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

vi.mock("./web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts:
    mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts:
    mocks.resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
}));

const {
  resolveBundledWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebSearchProvidersFromPublicArtifacts,
} = await import("./web-provider-public-artifacts.js");

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

describe("web provider public artifact manifest fallback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.readBundledDiscoveryModeMemoized.mockReturnValue("allowlist");
    mocks.loadPluginMetadataSnapshot.mockReturnValue(snapshot);
    mocks.resolvePluginMetadataSnapshot.mockImplementation((params) =>
      mocks.loadPluginMetadataSnapshot(params),
    );
    mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue([
      searchProvider,
    ]);
    mocks.resolveBundledExplicitWebFetchProvidersFromPublicArtifacts.mockReturnValue([
      fetchProvider,
    ]);
  });

  it("reuses prepared web-search owners without another manifest scan", () => {
    const providers = resolveBundledWebSearchProvidersFromPublicArtifacts({
      config: {},
      env,
      manifestRecords: snapshot.plugins,
    });

    expect(providers).toEqual([searchProvider]);
    expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(
      mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
    ).toHaveBeenCalledExactlyOnceWith({
      onlyPluginIds: ["fallback-search"],
      env,
      manifestRecords: snapshot.plugins,
    });
  });

  it("reuses the candidate manifest registry for bundled web-fetch artifacts", () => {
    const providers = resolveBundledWebFetchProvidersFromPublicArtifacts({ config: {}, env });

    expect(providers).toEqual([fetchProvider]);
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
    expect(
      mocks.resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
    ).toHaveBeenCalledExactlyOnceWith({
      onlyPluginIds: ["fallback-fetch"],
      env,
      manifestRecords: snapshot.plugins,
    });
  });

  it("loads an allowlisted named web-search provider without a manifest scan", () => {
    const providers = resolveBundledWebSearchProvidersFromPublicArtifacts({
      config: { plugins: { allow: ["fallback-search"] } },
      onlyPluginIds: ["blocked-search", "fallback-search"],
      env,
    });

    expect(providers).toEqual([searchProvider]);
    expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(
      mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
    ).toHaveBeenCalledExactlyOnceWith({
      onlyPluginIds: ["fallback-search"],
      env,
      manifestRecords: undefined,
    });
  });

  it("retries a named miss through the same batch with discovered owners", () => {
    mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValueOnce(null);

    const providers = resolveBundledWebSearchProvidersFromPublicArtifacts({
      config: {},
      onlyPluginIds: ["fallback-search"],
      env,
    });

    expect(providers).toEqual([searchProvider]);
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
    expect(mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mock.calls).toEqual([
      [{ onlyPluginIds: ["fallback-search"], env, manifestRecords: undefined }],
      [{ onlyPluginIds: ["fallback-search"], env, manifestRecords: snapshot.plugins }],
    ]);
  });

  it("keeps deprecated bundledDiscovery compat discovery outside plugin allowlists", () => {
    mocks.readBundledDiscoveryModeMemoized.mockReturnValue("compat");

    const providers = resolveBundledWebSearchProvidersFromPublicArtifacts({
      config: { plugins: { allow: ["some-other-plugin"] } },
      onlyPluginIds: ["fallback-search"],
      env,
    });

    expect(providers).toEqual([searchProvider]);
    expect(mocks.readBundledDiscoveryModeMemoized).toHaveBeenCalledWith(env);
    expect(
      mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
    ).toHaveBeenCalledExactlyOnceWith({
      onlyPluginIds: ["fallback-search"],
      env,
      manifestRecords: undefined,
    });
  });

  it("keeps manifest bundled web-fetch public artifact candidates inside allowlist discovery", () => {
    const fetchSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "blocked-fetch", contracts: { webFetchProviders: ["blocked-fetch"] } },
        { id: "fallback-fetch", contracts: { webFetchProviders: ["fallback-fetch"] } },
      ],
    });
    mocks.loadPluginMetadataSnapshot.mockReturnValueOnce(fetchSnapshot);

    const providers = resolveBundledWebFetchProvidersFromPublicArtifacts({
      config: { plugins: { allow: ["fallback-fetch"] } },
      env,
    });

    expect(providers).toEqual([fetchProvider]);
    expect(
      mocks.resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
    ).toHaveBeenCalledExactlyOnceWith({
      onlyPluginIds: ["fallback-fetch"],
      env,
      manifestRecords: fetchSnapshot.plugins,
    });
  });

  it("matches bundled web-search candidates through provider alias allowlist entries", () => {
    const googleSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "google", contracts: { webSearchProviders: ["gemini"] } }],
    });
    const gemini = createProvider("google", "gemini");
    mocks.loadPluginMetadataSnapshot.mockReturnValueOnce(googleSnapshot);
    mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValueOnce([gemini]);

    const providers = resolveBundledWebSearchProvidersFromPublicArtifacts({
      config: { plugins: { allow: ["google-gemini-cli"] } },
      env,
    });

    expect(providers).toEqual([gemini]);
    expect(
      mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
    ).toHaveBeenCalledExactlyOnceWith({
      onlyPluginIds: ["google"],
      env,
      manifestRecords: googleSnapshot.plugins,
    });
  });
});
