// Covers document extractor runtime hooks supplied by plugins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadBundledDocumentExtractorEntriesFromDir } from "./document-extractor-public-artifacts.js";
import { resolvePluginDocumentExtractors } from "./document-extractors.runtime.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

const mocks = vi.hoisted(() => ({
  readBundledDiscoveryModeMemoized: vi.fn<() => "allowlist" | "compat">(),
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

vi.mock("./document-extractor-public-artifacts.js", () => ({
  loadBundledDocumentExtractorEntriesFromDir: vi.fn(
    ({ dirName }: { dirName: string; pluginId: string }) =>
      dirName === "document-extract"
        ? [
            {
              id: "pdf",
              label: "PDF",
              mimeTypes: ["application/pdf"],
              pluginId: "document-extract",
              extract: vi.fn(),
            },
          ]
        : null,
  ),
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
  });

  it.each(["allowlist", "compat"] as const)(
    "reuses one manifest registry pass in %s mode",
    (mode) => {
      mocks.readBundledDiscoveryModeMemoized.mockReturnValue(mode);
      vi.mocked(loadPluginMetadataSnapshot).mockClear();

      expect(resolvePluginDocumentExtractors().map((extractor) => extractor.id)).toEqual(["pdf"]);
      expect(loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
    },
  );

  it("respects global plugin disablement even for an allowlisted extractor", () => {
    vi.mocked(loadPluginMetadataSnapshot).mockClear();
    vi.mocked(loadBundledDocumentExtractorEntriesFromDir).mockClear();
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
    expect(loadBundledDocumentExtractorEntriesFromDir).not.toHaveBeenCalled();
  });

  it.each([{ onlyPluginIds: undefined }, { onlyPluginIds: ["document-extract"] }])(
    "does not expand an operator plugin allowlist with scope=$onlyPluginIds",
    ({ onlyPluginIds }) => {
      expect(
        resolvePluginDocumentExtractors({
          config: {
            plugins: {
              allow: ["openai"],
            },
          },
          onlyPluginIds,
        }),
      ).toStrictEqual([]);
    },
  );

  it.each([
    { allow: [], onlyPluginIds: undefined, expected: ["pdf"] },
    { allow: ["DOCUMENT-EXTRACT"], onlyPluginIds: undefined, expected: ["pdf"] },
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

  it("respects an explicit empty plugin scope without an operator plugin allowlist", () => {
    expect(resolvePluginDocumentExtractors({ onlyPluginIds: [] })).toStrictEqual([]);
  });
});
