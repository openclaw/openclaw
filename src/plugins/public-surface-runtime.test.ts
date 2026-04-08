import { describe, expect, it } from "vitest";
import { normalizeBundledPluginArtifactSubpath } from "./public-surface-runtime.js";

describe("bundled plugin public surface runtime", () => {
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
