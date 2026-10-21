import { beforeEach, expect, it, vi } from "vitest";
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

// mock-isolation: Extractor availability comes from the fixture inventory, not host plugin discovery.
vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: (params?: { pluginMetadataSnapshot?: unknown }) =>
    params?.pluginMetadataSnapshot ?? mocks.loadPluginMetadataSnapshot(params),
}));

vi.mock("./manifest-registry.js", () => ({
  resolveManifestContractOwnerPluginId: vi.fn(() => undefined),
}));

const throwingFactory = (error: Error) => () => {
  throw error;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readBundledDiscoveryModeMemoized.mockReturnValue("compat");
  mocks.publicArtifactModule = {
    createPdfDocumentExtractor: () => ({
      id: "pdf",
      label: "PDF",
      mimeTypes: ["application/pdf"],
      extract: vi.fn(),
    }),
  };
  mocks.loadPublicArtifact.mockImplementation(({ dirName }) =>
    dirName === "document-extract" ? mocks.publicArtifactModule : null,
  );
});

it("reuses one manifest registry pass in allowlist mode", () => {
  mocks.readBundledDiscoveryModeMemoized.mockReturnValue("allowlist");

  expect(resolvePluginDocumentExtractors().map((extractor) => extractor.id)).toEqual(["pdf"]);
  expect(loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
});

const normalizedAllow = [" document-extract ", "document-extract"];
it.each([
  ["global disablement", false, ["document-extract"], []],
  ["cannot expand allowlist", undefined, ["openai"], []],
  ["normalized allowlist", undefined, normalizedAllow, ["pdf"]],
] as const)("enforces %s", (_name, enabled, allow, expected) => {
  const result = resolvePluginDocumentExtractors({
    config: { plugins: { enabled, allow: [...allow] } },
  });
  expect(result).toStrictEqual(expected.map((id) => expect.objectContaining({ id })));
  if (enabled === false) {
    expect(loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadPublicArtifact).not.toHaveBeenCalled();
  }
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

it.each([
  ["module", true],
  ["factory", true],
  ["factories", true],
  ["factory", false],
] as const)("reports failed %s initialization (healthy sibling: %s)", (kind, healthy) => {
  const pluginId = healthy ? "broken-extract" : "document-extract";
  const error = new Error(healthy ? "broken-extract module failed" : "native probe failed");
  const secondError = new Error("second extractor failed");
  if (healthy) {
    const snapshot = mocks.loadPluginMetadataSnapshot();
    mocks.loadPluginMetadataSnapshot.mockReturnValueOnce({
      plugins: [...snapshot.plugins, mocks.plugin(pluginId, { documentExtractors: ["broken"] })],
    });
  }
  mocks.loadPublicArtifact.mockImplementation(({ dirName }) => {
    if (dirName === pluginId) {
      if (kind === "module") {
        throw error;
      }
      return Object.fromEntries(
        (kind === "factory" ? [error] : [error, secondError]).map((cause, index) => [
          `create${index}DocumentExtractor`,
          throwingFactory(cause),
        ]),
      );
    }
    return dirName === "document-extract" ? mocks.publicArtifactModule : null;
  });
  if (!healthy) {
    expect(resolvePluginDocumentExtractors).toThrow(
      expect.objectContaining({
        message: "Unable to load document extractor plugins",
        cause: expect.objectContaining({
          message: "Unable to initialize document extractors for plugin document-extract",
          cause: error,
        }),
      }),
    );
    expect(mocks.warn).not.toHaveBeenCalled();
    return;
  }
  expect(resolvePluginDocumentExtractors().map((extractor) => extractor.id)).toEqual(["pdf"]);
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
});
