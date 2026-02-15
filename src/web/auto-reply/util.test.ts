import { describe, expect, it } from "vitest";
import { elide, isLikelyWhatsAppCryptoError } from "./util.js";

describe("web auto-reply util", () => {
  describe("elide", () => {
    it("returns undefined for undefined input", () => {
      expect(elide(undefined)).toBe(undefined);
    });

    it("returns input when under limit", () => {
      expect(elide("hi", 10)).toBe("hi");
    });

    it("returns input when exactly at limit", () => {
      expect(elide("12345", 5)).toBe("12345");
    });

    it("truncates and annotates when over limit", () => {
      expect(elide("abcdef", 3)).toBe("abc… (truncated 3 chars)");
    });
  });

  describe("isLikelyWhatsAppCryptoError", () => {
    it("returns false for non-matching reasons", () => {
      expect(isLikelyWhatsAppCryptoError(new Error("boom"))).toBe(false);
      expect(isLikelyWhatsAppCryptoError("boom")).toBe(false);
      expect(isLikelyWhatsAppCryptoError({ message: "bad mac" })).toBe(false);
    });

    it("matches known Baileys crypto auth errors (string)", () => {
      expect(
        isLikelyWhatsAppCryptoError(
          "baileys: unsupported state or unable to authenticate data (noise-handler)",
        ),
      ).toBe(true);
      expect(isLikelyWhatsAppCryptoError("bad mac in aesDecryptGCM (baileys)")).toBe(true);
    });

    it("matches known Baileys crypto auth errors (Error)", () => {
      const err = new Error("bad mac");
      err.stack = "at something\nat @whiskeysockets/baileys/noise-handler\n";
      expect(isLikelyWhatsAppCryptoError(err)).toBe(true);
    });

    it("does not throw on circular objects", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(isLikelyWhatsAppCryptoError(circular)).toBe(false);
    });
  });
});
