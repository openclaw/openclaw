/**
 * Tests for plugin catalog presentation helpers.
 */
import { describe, expect, it } from "vitest";
import { pluginMonogram } from "./presentation.ts";

describe("ui/pages/plugins/presentation", () => {
  it("builds monograms from one or two words", () => {
    expect(pluginMonogram("OpenClaw")).toBe("OP");
    expect(pluginMonogram("Foo Bar")).toBe("FB");
  });

  it("trims whitespace before building the monogram", () => {
    expect(pluginMonogram("  Linear  ")).toBe("LI");
    expect(pluginMonogram("  GitHub   Copilot  ")).toBe("GC");
  });

  it("returns an empty string for empty input", () => {
    expect(pluginMonogram("")).toBe("");
    expect(pluginMonogram("   ")).toBe("");
  });

  it("does not split surrogate pairs when truncating a single word", () => {
    const monogram = pluginMonogram("a😀b");
    expect(monogram).toBe("A");
    expect(() => encodeURIComponent(monogram)).not.toThrow();
  });
});
