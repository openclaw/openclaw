import { describe, it, expect } from "vitest";
import { resolveImageCompressionSettings, IMAGE_COMPRESSION_PRESETS } from "./image-compression.js";

describe("resolveImageCompressionSettings", () => {
  it("returns medium preset by default", () => {
    const result = resolveImageCompressionSettings({});
    expect(result.maxSide).toBe(1200);
    expect(result.quality).toBe(70);
  });

  it("resolves 'none' preset", () => {
    const result = resolveImageCompressionSettings({ compression: "none" });
    expect(result.optimize).toBe(false);
  });

  it("resolves 'low' preset", () => {
    const result = resolveImageCompressionSettings({ compression: "low" });
    expect(result.maxSide).toBe(800);
    expect(result.quality).toBe(50);
  });

  it("resolves 'medium' preset", () => {
    const result = resolveImageCompressionSettings({ compression: "medium" });
    expect(result.maxSide).toBe(1200);
    expect(result.quality).toBe(70);
  });

  it("resolves 'high' preset", () => {
    const result = resolveImageCompressionSettings({ compression: "high" });
    expect(result.maxSide).toBe(2000);
    expect(result.quality).toBe(95);
  });

  it("resolves detailed config with maxWidth", () => {
    const result = resolveImageCompressionSettings({
      compression: { maxWidth: 1500 },
    });
    expect(result.maxSide).toBe(1500);
    expect(result.quality).toBe(95); // default quality for detail mode
  });

  it("resolves detailed config with all fields", () => {
    const result = resolveImageCompressionSettings({
      compression: { maxWidth: 1800, maxHeight: 1600, quality: 85 },
    });
    expect(result.maxSide).toBe(1600); // min of maxWidth and maxHeight
    expect(result.quality).toBe(85);
  });

  it("uses quality from detail config", () => {
    const result = resolveImageCompressionSettings({
      compression: { quality: 90 },
    });
    expect(result.maxSide).toBe(2000); // default max side for detail mode
    expect(result.quality).toBe(90);
  });
});

describe("IMAGE_COMPRESSION_PRESETS", () => {
  it("has correct values", () => {
    expect(IMAGE_COMPRESSION_PRESETS.none).toEqual({ optimize: false });
    expect(IMAGE_COMPRESSION_PRESETS.low).toEqual({ maxSide: 800, quality: 50, optimize: true });
    expect(IMAGE_COMPRESSION_PRESETS.medium).toEqual({
      maxSide: 1200,
      quality: 70,
      optimize: true,
    });
    expect(IMAGE_COMPRESSION_PRESETS.high).toEqual({ maxSide: 2000, quality: 95, optimize: true });
  });
});
