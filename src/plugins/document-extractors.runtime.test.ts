import { beforeEach, expect, it, vi } from "vitest";
import { resolvePluginDocumentExtractors } from "./document-extractors.runtime.js";

const mocks = vi.hoisted(() => {
  const plugin = (id: string, contracts: { documentExtractors?: string[] } = {}) => ({
    id,
    origin: "bundled",
    enabledByDefault: true,
    channels: [],
    contracts,
  });
  return {
    plugin,
    warn: vi.fn(),
    readBundledDiscoveryModeMemoized: vi.fn<() => "allowlist" | "compat">(),
    publicArtifactModule: {} as Record<string, unknown>,
    loadPublicArtifact: vi.fn<(params: { dirName: string }) => Record<string, unknown> | null>(),
    loadPluginMetadataSnapshot: vi.fn((_params?: unknown) => ({
      plugins: [plugin("document-extract", { documentExtractors: ["pdf"] }), plugin("openai")],
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

const throwing = (error: Error) => () => {
  throw error;
};
const pdfFields = { id: "pdf", label: "PDF", mimeTypes: ["application/pdf"] };
const expectPdf = () =>
  expect(resolvePluginDocumentExtractors()).toStrictEqual([
    { ...pdfFields, extract: expect.any(Function), pluginId: "document-extract" },
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readBundledDiscoveryModeMemoized.mockReturnValue("compat");
  mocks.publicArtifactModule = {
    createPdfDocumentExtractor: () => ({ ...pdfFields, extract: vi.fn() }),
  };
  mocks.loadPublicArtifact.mockImplementation(({ dirName }) =>
    dirName === "document-extract" ? mocks.publicArtifactModule : null,
  );
});

it.each([
  ["global disablement", false, ["document-extract"], []],
  ["cannot expand allowlist", undefined, ["openai"], []],
  ["normalized allowlist", undefined, [" document-extract ", "document-extract"], ["pdf"]],
] as const)("enforces %s", (_name, enabled, allow, expected) => {
  if (expected.length) {
    mocks.readBundledDiscoveryModeMemoized.mockReturnValue("allowlist");
  }
  const result = resolvePluginDocumentExtractors({
    config: { plugins: { enabled, allow: [...allow] } },
  });
  expect(result).toStrictEqual(expected.map((id) => expect.objectContaining({ id })));
  if (enabled === false) {
    expect(mocks.loadPublicArtifact).not.toHaveBeenCalled();
  }
});

it.each(["module", "factories"] as const)("reports failed %s initialization", (kind) => {
  const healthy = kind === "module";
  const pluginId = healthy ? "broken-extract" : "document-extract";
  const error = new Error("extractor failed");
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
        [error, secondError].map((cause, index) => [
          `create${index}DocumentExtractor`,
          throwing(cause),
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
          message: `Unable to initialize document extractors for plugin ${pluginId}`,
          cause: expect.any(AggregateError),
        }),
      }),
    );
    return;
  }
  expectPdf();
  expect(mocks.warn).toHaveBeenCalledWith(
    expect.stringContaining("using healthy extractors"),
    expect.objectContaining({ error }),
  );
});
