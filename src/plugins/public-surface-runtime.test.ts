import { describe, expect, it } from "vitest";
import {
  PUBLIC_SURFACE_SOURCE_EXTENSIONS,
  normalizeBundledPluginArtifactSubpath,
} from "./public-surface-runtime.js";

describe("bundled plugin public surface runtime", () => {
  it("exports the canonical public surface source extension list", () => {
    expect(PUBLIC_SURFACE_SOURCE_EXTENSIONS).toEqual([
      ".ts",
      ".mts",
      ".js",
      ".mjs",
      ".cts",
      ".cjs",
    ]);
  });

  it("allows plugin-local nested artifact paths", () => {
    expect(normalizeBundledPluginArtifactSubpath("src/outbound-adapter.js")).toBe(
      "src/outbound-adapter.js",
    );
    expect(normalizeBundledPluginArtifactSubpath("./test-api.js")).toBe("test-api.js");
  });

  it("rejects artifact paths that escape the plugin root", () => {
    expect(() => normalizeBundledPluginArtifactSubpath("../outside.js")).toThrow(
      /must stay plugin-local/,
    );
    expect(() => normalizeBundledPluginArtifactSubpath("src/../outside.js")).toThrow(
      /must stay plugin-local/,
    );
    expect(() => normalizeBundledPluginArtifactSubpath("/tmp/outside.js")).toThrow(
      /must stay plugin-local/,
    );
    expect(() => normalizeBundledPluginArtifactSubpath("..\\outside.js")).toThrow(
      /must stay plugin-local/,
    );
    expect(() => normalizeBundledPluginArtifactSubpath("C:outside.js")).toThrow(
      /must stay plugin-local/,
    );
    expect(() => normalizeBundledPluginArtifactSubpath("src/C:outside.js")).toThrow(
      /must stay plugin-local/,
    );
  });
});
