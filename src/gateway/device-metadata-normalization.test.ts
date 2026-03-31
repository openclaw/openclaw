import { describe, expect, it } from "vitest";
import {
  normalizeDeviceMetadataForAuth,
  normalizeDeviceMetadataForPolicy,
} from "./device-metadata-normalization.js";

describe("normalizeDeviceMetadataForAuth", () => {
  it("lowercases ASCII characters", () => {
    expect(normalizeDeviceMetadataForAuth("MyDevice")).toBe("mydevice");
  });

  it("preserves already-lowercase input", () => {
    expect(normalizeDeviceMetadataForAuth("pixel7")).toBe("pixel7");
  });

  it("preserves non-ASCII characters without lowercasing them", () => {
    // Only ASCII A-Z should be lowered; non-ASCII stays as-is
    expect(normalizeDeviceMetadataForAuth("Ñoño")).toBe("Ñoño");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeDeviceMetadataForAuth("  iPhone 15  ")).toBe("iphone 15");
  });

  it("returns empty string for null", () => {
    expect(normalizeDeviceMetadataForAuth(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(normalizeDeviceMetadataForAuth(undefined)).toBe("");
  });

  it("returns empty string for non-string values", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeDeviceMetadataForAuth(42 as any)).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeDeviceMetadataForAuth("   ")).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(normalizeDeviceMetadataForAuth("")).toBe("");
  });
});

describe("normalizeDeviceMetadataForPolicy", () => {
  it("decomposes and strips diacritical marks via NFKD", () => {
    expect(normalizeDeviceMetadataForPolicy("café")).toBe("cafe");
  });

  it("decomposes Ñ to N and lowercases", () => {
    expect(normalizeDeviceMetadataForPolicy("Ñ")).toBe("n");
  });

  it("decomposes ü to u", () => {
    expect(normalizeDeviceMetadataForPolicy("ü")).toBe("u");
  });

  it("lowercases after decomposition", () => {
    expect(normalizeDeviceMetadataForPolicy("ÜBER")).toBe("uber");
  });

  it("handles complex multi-diacritic input", () => {
    expect(normalizeDeviceMetadataForPolicy("résumé")).toBe("resume");
  });

  it("trims whitespace before normalizing", () => {
    expect(normalizeDeviceMetadataForPolicy("  Ñoño  ")).toBe("nono");
  });

  it("returns empty string for null", () => {
    expect(normalizeDeviceMetadataForPolicy(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(normalizeDeviceMetadataForPolicy(undefined)).toBe("");
  });

  it("returns empty string for non-string values", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeDeviceMetadataForPolicy(123 as any)).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeDeviceMetadataForPolicy("   ")).toBe("");
  });

  it("passes through plain ASCII unchanged", () => {
    expect(normalizeDeviceMetadataForPolicy("pixel7")).toBe("pixel7");
  });

  it("strips combining marks but preserves non-mark emoji codepoints", () => {
    // Skin-tone modifiers (U+1F3FB) are not Unicode combining marks (\p{M}),
    // so NFKD + mark stripping leaves them intact alongside the base emoji.
    const wave = "\u{1F44B}\u{1F3FB}"; // 👋🏻
    const result = normalizeDeviceMetadataForPolicy(wave);
    expect(result).toBe("\u{1F44B}\u{1F3FB}");
  });

  it("strips actual combining marks from accented characters", () => {
    // é (U+0065 + U+0301) after NFKD → 'e' + combining acute, mark stripped → 'e'
    const precomposed = "\u00E9"; // é (NFC)
    expect(normalizeDeviceMetadataForPolicy(precomposed)).toBe("e");
  });
});
