import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveManifestDeclaredWebProviderCandidatePluginIds } from "./web-provider-resolution-shared.js";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

describe("resolveManifestDeclaredWebProviderCandidatePluginIds", () => {
  const resolve = (params: { onlyPluginIds?: string[]; origin?: "bundled" } = {}) =>
    resolveManifestDeclaredWebProviderCandidatePluginIds({
      contract: "webSearchProviders",
      configKey: "webSearch",
      ...params,
    });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: [
        { id: "alpha", origin: "bundled", configSchema: { properties: { webSearch: {} } } },
        { id: "beta", origin: "bundled", contracts: { webSearchProviders: ["beta-search"] } },
      ],
      diagnostics: [],
    });
  });

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(resolve({ onlyPluginIds: [] })).toStrictEqual([]);
    expect(mocks.resolvePluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("keeps scoped plugins with no declared web candidates scoped-empty", () => {
    expect(resolve({ onlyPluginIds: ["missing-plugin"] })).toStrictEqual([]);
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps origin filters with no declared web candidates scoped-empty", () => {
    mocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: [{ id: "workspace-tool", origin: "workspace", configSchema: { properties: {} } }],
      diagnostics: [],
    });

    expect(resolve({ origin: "bundled" })).toStrictEqual([]);
  });

  it("limits sandboxed web fetch candidates to bundled and trusted official installs", () => {
    mocks.resolvePluginMetadataSnapshot.mockReturnValue({
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
  });
});
