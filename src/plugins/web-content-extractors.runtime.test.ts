import { describe, expect, it, vi } from "vitest";

const { loadBundledWebContentExtractorEntriesFromDir } = vi.hoisted(() => ({
  loadBundledWebContentExtractorEntriesFromDir: vi.fn(
    ({ dirName }: { dirName: string; pluginId: string }) => {
      if (dirName === "broken-readability") {
        throw new Error("native probe failed");
      }
      if (dirName === "web-readability") {
        return [
          {
            id: "readability",
            label: "Readability",
            pluginId: "web-readability",
            extract: vi.fn(),
          },
        ];
      }
      return null;
    },
  ),
}));

vi.mock("./manifest-contract-eligibility.js", () => ({
  loadManifestContractSnapshot: vi.fn(() => ({
    index: { plugins: [], providers: {} },
    plugins: [
      {
        id: "broken-readability",
        origin: "bundled",
        enabledByDefault: true,
        enabledByDefaultOnPlatforms: [],
        channels: [],
        cliBackends: [],
        providers: [],
        legacyPluginIds: [],
        contracts: { webContentExtractors: ["broken"] },
      },
      {
        id: "web-readability",
        origin: "bundled",
        enabledByDefault: true,
        enabledByDefaultOnPlatforms: [],
        channels: [],
        cliBackends: [],
        providers: [],
        legacyPluginIds: [],
        contracts: { webContentExtractors: ["readability"] },
      },
    ],
  })),
}));

vi.mock("./web-content-extractor-public-artifacts.js", () => ({
  loadBundledWebContentExtractorEntriesFromDir,
}));

import { resolvePluginWebContentExtractors } from "./web-content-extractors.runtime.js";

describe("resolvePluginWebContentExtractors", () => {
  it("respects global plugin disablement", () => {
    expect(
      resolvePluginWebContentExtractors({
        config: {
          plugins: {
            enabled: false,
          },
        },
      }),
    ).toStrictEqual([]);
  });

  it("isolates one plugin load failure when another extractor plugin succeeds", () => {
    expect(resolvePluginWebContentExtractors().map((extractor) => extractor.id)).toEqual([
      "readability",
    ]);
  });

  it("surfaces plugin load failure when every extractor plugin fails", () => {
    expect(() =>
      resolvePluginWebContentExtractors({
        onlyPluginIds: ["broken-readability"],
      }),
    ).toThrow("Unable to load web content extractor plugins");
  });
});
