import { describe, expect, it } from "vitest";
import {
  requireInRange,
  normalizeLanguageCode,
  normalizeApplyTextNormalization,
  normalizeSeed,
} from "./tts-core.js";

describe("tts-core validation functions", () => {
  describe("requireInRange", () => {
    it("should accept valid values within range", () => {
      expect(() => requireInRange(5, 1, 10, "test")).not.toThrow();
      expect(() => requireInRange(1, 1, 10, "test")).not.toThrow();
      expect(() => requireInRange(10, 1, 10, "test")).not.toThrow();
    });

    it("should reject values outside range with descriptive error", () => {
      expect(() => requireInRange(0, 1, 10, "test")).toThrow(
        "Invalid test: 0. Must be between 1 and 10."
      );
      expect(() => requireInRange(11, 1, 10, "test")).toThrow(
        "Invalid test: 11. Must be between 1 and 10."
      );
    });

    it("should reject non-finite values with descriptive error", () => {
      expect(() => requireInRange(NaN, 1, 10, "test")).toThrow(
        "Invalid test: NaN. Must be between 1 and 10."
      );
      expect(() => requireInRange(Infinity, 1, 10, "test")).toThrow(
        "Invalid test: Infinity. Must be between 1 and 10."
      );
      expect(() => requireInRange(-Infinity, 1, 10, "test")).toThrow(
        "Invalid test: -Infinity. Must be between 1 and 10."
      );
    });
  });

  describe("normalizeLanguageCode", () => {
    it("should accept valid 2-letter ISO codes", () => {
      expect(normalizeLanguageCode("en")).toBe("en");
      expect(normalizeLanguageCode("de")).toBe("de");
      expect(normalizeLanguageCode("fr")).toBe("fr");
      expect(normalizeLanguageCode("EN")).toBe("en");
      expect(normalizeLanguageCode("  en  ")).toBe("en");
    });

    it("should return undefined for empty input", () => {
      expect(normalizeLanguageCode("")).toBeUndefined();
      expect(normalizeLanguageCode("   ")).toBeUndefined();
      expect(normalizeLanguageCode(undefined)).toBeUndefined();
    });

    it("should reject invalid codes with descriptive error", () => {
      expect(() => normalizeLanguageCode("eng")).toThrow(
        'Invalid language code "eng". Must be a 2-letter ISO 639-1 code (e.g. en, de, fr).'
      );
      expect(() => normalizeLanguageCode("e")).toThrow(
        'Invalid language code "e". Must be a 2-letter ISO 639-1 code (e.g. en, de, fr).'
      );
      expect(() => normalizeLanguageCode("123")).toThrow(
        'Invalid language code "123". Must be a 2-letter ISO 639-1 code (e.g. en, de, fr).'
      );
      expect(() => normalizeLanguageCode("en-US")).toThrow(
        'Invalid language code "en-US". Must be a 2-letter ISO 639-1 code (e.g. en, de, fr).'
      );
    });
  });

  describe("normalizeApplyTextNormalization", () => {
    it("should accept valid normalization modes", () => {
      expect(normalizeApplyTextNormalization("auto")).toBe("auto");
      expect(normalizeApplyTextNormalization("on")).toBe("on");
      expect(normalizeApplyTextNormalization("off")).toBe("off");
      expect(normalizeApplyTextNormalization("AUTO")).toBe("auto");
      expect(normalizeApplyTextNormalization("  on  ")).toBe("on");
    });

    it("should return undefined for empty input", () => {
      expect(normalizeApplyTextNormalization("")).toBeUndefined();
      expect(normalizeApplyTextNormalization("   ")).toBeUndefined();
      expect(normalizeApplyTextNormalization(undefined)).toBeUndefined();
    });

    it("should reject invalid modes with descriptive error", () => {
      expect(() => normalizeApplyTextNormalization("enabled")).toThrow(
        'Invalid text normalization mode "enabled". Must be one of: auto, on, off.'
      );
      expect(() => normalizeApplyTextNormalization("disabled")).toThrow(
        'Invalid text normalization mode "disabled". Must be one of: auto, on, off.'
      );
      expect(() => normalizeApplyTextNormalization("true")).toThrow(
        'Invalid text normalization mode "true". Must be one of: auto, on, off.'
      );
    });
  });

  describe("normalizeSeed", () => {
    it("should accept valid seed values", () => {
      expect(normalizeSeed(0)).toBe(0);
      expect(normalizeSeed(123)).toBe(123);
      expect(normalizeSeed(4294967295)).toBe(4294967295);
      expect(normalizeSeed(123.7)).toBe(123);
      expect(normalizeSeed(undefined)).toBeUndefined();
    });

    it("should reject negative values with descriptive error", () => {
      expect(() => normalizeSeed(-1)).toThrow(
        "Invalid seed value: -1. Must be between 0 and 4294967295."
      );
    });

    it("should reject values above maximum with descriptive error", () => {
      expect(() => normalizeSeed(4294967296)).toThrow(
        "Invalid seed value: 4294967296. Must be between 0 and 4294967295."
      );
    });

    it("should reject non-finite values with descriptive error", () => {
      expect(() => normalizeSeed(NaN)).toThrow(
        "Invalid seed value: NaN. Must be between 0 and 4294967295."
      );
      expect(() => normalizeSeed(Infinity)).toThrow(
        "Invalid seed value: Infinity. Must be between 0 and 4294967295."
      );
    });
  });
});
