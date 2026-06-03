import { beforeEach, describe, expect, it, vi } from "vitest";

const { publicArtifactModule } = vi.hoisted(() => ({
  publicArtifactModule: {} as Record<string, unknown>,
}));

vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: vi.fn(() => publicArtifactModule),
  resolveBundledPluginPublicArtifactPath: vi.fn(
    () => "/repo/extensions/demo/web-content-extractor.ts",
  ),
}));

import { loadBundledWebContentExtractorEntriesFromDir } from "./web-content-extractor-public-artifacts.js";

describe("loadBundledWebContentExtractorEntriesFromDir", () => {
  beforeEach(() => {
    for (const key of Object.keys(publicArtifactModule)) {
      delete publicArtifactModule[key];
    }
  });

  it("isolates a throwing factory when another extractor factory succeeds", () => {
    const extract = vi.fn();
    publicArtifactModule.createBrokenWebContentExtractor = () => {
      throw new Error("native probe failed");
    };
    publicArtifactModule.createReadabilityWebContentExtractor = () => ({
      id: "readability",
      label: "Readability",
      extract,
    });

    expect(
      loadBundledWebContentExtractorEntriesFromDir({
        dirName: "demo",
        pluginId: "demo",
      }),
    ).toStrictEqual([
      {
        id: "readability",
        label: "Readability",
        extract,
        pluginId: "demo",
      },
    ]);
  });

  it("surfaces initialization failure when every matching factory throws", () => {
    const cause = new Error("native probe failed");
    publicArtifactModule.createReadabilityWebContentExtractor = () => {
      throw cause;
    };

    expect(() =>
      loadBundledWebContentExtractorEntriesFromDir({
        dirName: "demo",
        pluginId: "demo",
      }),
    ).toThrow("Unable to initialize web content extractors for plugin demo");
  });

  it("isolates a malformed descriptor when another extractor factory succeeds", () => {
    const extract = vi.fn();
    publicArtifactModule.createBrokenWebContentExtractor = () => ({
      get id() {
        throw new Error("descriptor read failed");
      },
    });
    publicArtifactModule.createReadabilityWebContentExtractor = () => ({
      id: "readability",
      label: "Readability",
      extract,
    });

    expect(
      loadBundledWebContentExtractorEntriesFromDir({
        dirName: "demo",
        pluginId: "demo",
      }),
    ).toStrictEqual([
      {
        id: "readability",
        label: "Readability",
        extract,
        pluginId: "demo",
      },
    ]);
  });
});
