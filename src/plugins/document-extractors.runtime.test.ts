// Covers document extractor runtime hooks supplied by plugins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginDocumentExtractors } from "./document-extractors.runtime.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

const mocks = vi.hoisted(() => ({
  readBundledDiscoveryModeMemoized: vi.fn<() => "allowlist" | "compat">(),
  publicArtifactModule: {} as Record<string, unknown>,
  loadPublicArtifact: vi.fn<(params: { dirName: string }) => Record<string, unknown> | null>(),
  loadPluginMetadataSnapshot: vi.fn((_params?: unknown) => ({
    plugins: [
      {
        id: "document-extract",
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        cliBackends: [],
        providers: [],
        legacyPluginIds: [],
        contracts: { documentExtractors: ["pdf"] },
      },
      {
        id: "openai",
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        cliBackends: [],
        providers: ["openai", "openai"],
        legacyPluginIds: [],
        contracts: {},
      },
    ],
  })),
}));

vi.mock("./bundled-discovery-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bundled-discovery-state.js")>()),
  readBundledDiscoveryModeMemoized: mocks.readBundledDiscoveryModeMemoized,
}));

// mock-isolation: extractor factories come from the fixture, without loading installed plugins.
vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: mocks.loadPublicArtifact,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: vi.fn(
    (params?: { pluginMetadataSnapshot?: unknown }) =>
      params?.pluginMetadataSnapshot ?? mocks.loadPluginMetadataSnapshot(params),
  ),
}));

vi.mock("./manifest-registry.js", () => ({
  resolveManifestContractOwnerPluginId: vi.fn(() => undefined),
}));

describe("resolvePluginDocumentExtractors", () => {
  beforeEach(() => {
    mocks.readBundledDiscoveryModeMemoized.mockReturnValue("compat");
    mocks.publicArtifactModule = {
      createPdfDocumentExtractor: () => ({
        id: "pdf",
        label: "PDF",
        mimeTypes: ["application/pdf"],
        extract: vi.fn(),
      }),
    };
    mocks.loadPublicArtifact
      .mockReset()
      .mockImplementation(({ dirName }) =>
        dirName === "document-extract" ? mocks.publicArtifactModule : null,
      );
  });

  it("reuses one manifest registry pass in allowlist mode", () => {
    mocks.readBundledDiscoveryModeMemoized.mockReturnValue("allowlist");
    vi.mocked(loadPluginMetadataSnapshot).mockClear();

    expect(resolvePluginDocumentExtractors().map((extractor) => extractor.id)).toEqual(["pdf"]);
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("respects global plugin disablement even for an allowlisted extractor", () => {
    vi.mocked(loadPluginMetadataSnapshot).mockClear();
    mocks.loadPublicArtifact.mockClear();
    expect(
      resolvePluginDocumentExtractors({
        config: {
          plugins: {
            enabled: false,
            allow: ["document-extract"],
          },
        },
      }),
    ).toStrictEqual([]);
    expect(loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadPublicArtifact).not.toHaveBeenCalled();
  });

  it("does not expand an operator plugin allowlist with an explicit extractor scope", () => {
    expect(
      resolvePluginDocumentExtractors({
        config: { plugins: { allow: ["openai"] } },
        onlyPluginIds: ["document-extract"],
      }),
    ).toStrictEqual([]);
  });

  it.each([
    {
      allow: [" document-extract ", "document-extract"],
      onlyPluginIds: ["document-extract"],
      expected: ["pdf"],
    },
    { allow: [" document-extract ", "document-extract"], onlyPluginIds: ["openai"], expected: [] },
  ])(
    "intersects normalized allow=$allow with scope=$onlyPluginIds",
    ({ allow, onlyPluginIds, expected }) => {
      expect(
        resolvePluginDocumentExtractors({ config: { plugins: { allow } }, onlyPluginIds }).map(
          (extractor) => extractor.id,
        ),
      ).toEqual(expected);
    },
  );

  it("respects an explicit empty plugin scope with an operator plugin allowlist", () => {
    expect(
      resolvePluginDocumentExtractors({
        config: {
          plugins: {
            allow: ["document-extract"],
          },
        },
        onlyPluginIds: [],
      }),
    ).toStrictEqual([]);
  });

  it("isolates a throwing factory when another extractor factory succeeds", () => {
    mocks.publicArtifactModule.createBrokenDocumentExtractor = () => {
      throw new Error("native probe failed");
    };

    expect(resolvePluginDocumentExtractors()).toStrictEqual([
      {
        id: "pdf",
        label: "PDF",
        mimeTypes: ["application/pdf"],
        extract: expect.any(Function),
        pluginId: "document-extract",
      },
    ]);
  });

  it("surfaces initialization failure when every matching factory throws", () => {
    const cause = new Error("native probe failed");
    mocks.publicArtifactModule.createPdfDocumentExtractor = () => {
      throw cause;
    };

    expect(resolvePluginDocumentExtractors).toThrow(
      expect.objectContaining({
        message: "Unable to load document extractor plugins",
        cause: expect.objectContaining({
          message: "Unable to initialize document extractors for plugin document-extract",
          cause,
        }),
      }),
    );
  });
});
