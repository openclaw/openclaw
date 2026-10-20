import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginDocumentExtractors } from "./document-extractors.runtime.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

const mocks = vi.hoisted(() => {
  const plugin = (
    id: string,
    contracts: { documentExtractors?: string[] } = {},
    providers: string[] = [],
  ) => ({
    id,
    origin: "bundled",
    enabledByDefault: true,
    channels: [],
    cliBackends: [],
    providers,
    legacyPluginIds: [],
    contracts,
  });
  return {
    plugin,
    warn: vi.fn(),
    readBundledDiscoveryModeMemoized: vi.fn<() => "allowlist" | "compat">(),
    publicArtifactModule: {} as Record<string, unknown>,
    loadPublicArtifact: vi.fn<(params: { dirName: string }) => Record<string, unknown> | null>(),
    loadPluginMetadataSnapshot: vi.fn((_params?: unknown) => ({
      plugins: [
        plugin("document-extract", { documentExtractors: ["pdf"] }),
        plugin("openai", {}, ["openai", "openai"]),
      ],
    })),
  };
});

vi.mock("../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({
    warn: mocks.warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
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

const extractorIds = (params?: Parameters<typeof resolvePluginDocumentExtractors>[0]) =>
  resolvePluginDocumentExtractors(params).map((extractor) => extractor.id);
const throwingFactory = (error: Error) => () => {
  throw error;
};

describe("resolvePluginDocumentExtractors", () => {
  beforeEach(() => {
    mocks.warn.mockClear();
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

    expect(extractorIds()).toEqual(["pdf"]);
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("respects global plugin disablement even for an allowlisted extractor", () => {
    vi.mocked(loadPluginMetadataSnapshot).mockClear();
    mocks.loadPublicArtifact.mockClear();
    expect(
      resolvePluginDocumentExtractors({
        config: { plugins: { enabled: false, allow: ["document-extract"] } },
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
    [["document-extract"], ["pdf"]],
    [["openai"], []],
  ])("intersects the normalized allowlist with scope=%s", (onlyPluginIds, expected) => {
    expect(
      extractorIds({
        config: { plugins: { allow: [" document-extract ", "document-extract"] } },
        onlyPluginIds,
      }),
    ).toEqual(expected);
  });

  it("respects an explicit empty plugin scope with an operator plugin allowlist", () => {
    expect(
      resolvePluginDocumentExtractors({
        config: { plugins: { allow: ["document-extract"] } },
        onlyPluginIds: [],
      }),
    ).toStrictEqual([]);
  });

  it("isolates a throwing factory when another extractor factory succeeds", () => {
    const error = new Error("native probe failed");
    mocks.publicArtifactModule.createBrokenDocumentExtractor = throwingFactory(error);

    expect(resolvePluginDocumentExtractors()).toStrictEqual([
      {
        id: "pdf",
        label: "PDF",
        mimeTypes: ["application/pdf"],
        extract: expect.any(Function),
        pluginId: "document-extract",
      },
    ]);
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/document extractors.*document-extract/),
      { error },
    );
  });

  it.each(["module", "factory", "factories"])(
    "reports failed %s initialization with healthy extractors",
    (kind) => {
      const error = new Error("broken-extract module failed");
      const secondError = new Error("second extractor failed");
      const snapshot = mocks.loadPluginMetadataSnapshot();
      mocks.loadPluginMetadataSnapshot.mockReturnValueOnce({
        plugins: [
          ...snapshot.plugins,
          mocks.plugin("broken-extract", { documentExtractors: ["broken"] }),
        ],
      });
      mocks.loadPublicArtifact.mockImplementation(({ dirName }) => {
        if (dirName === "broken-extract") {
          if (kind === "module") {
            throw error;
          }
          const factories = { createBrokenDocumentExtractor: throwingFactory(error) };
          return kind === "factory"
            ? factories
            : {
                ...factories,
                createSecondDocumentExtractor: throwingFactory(secondError),
              };
        }
        return dirName === "document-extract" ? mocks.publicArtifactModule : null;
      });

      expect(extractorIds()).toEqual(["pdf"]);
      expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("using healthy extractors"),
        {
          error:
            kind === "module"
              ? error
              : expect.objectContaining({
                  cause: kind === "factory" ? error : expect.any(AggregateError),
                }),
          detail:
            kind === "module"
              ? "broken-extract module failed"
              : `Unable to initialize document extractors for plugin broken-extract | broken-extract module failed${kind === "factories" ? " | second extractor failed" : ""}`,
        },
      );
    },
  );

  it("surfaces initialization failure when every matching factory throws", () => {
    const cause = new Error("native probe failed");
    mocks.publicArtifactModule.createPdfDocumentExtractor = throwingFactory(cause);

    expect(resolvePluginDocumentExtractors).toThrow(
      expect.objectContaining({
        message: "Unable to load document extractor plugins",
        cause: expect.objectContaining({
          message: "Unable to initialize document extractors for plugin document-extract",
          cause,
        }),
      }),
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
