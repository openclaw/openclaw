import { describe, expect, it } from "vitest";
import { resolveTrustTier } from "./trust.js";
import type { PluginBundleFormat, PluginOrigin } from "./types.js";

const ALL_ORIGINS: PluginOrigin[] = ["bundled", "global", "workspace", "config"];
const BUNDLE_FORMATS: PluginBundleFormat[] = ["codex", "claude", "cursor"];

describe("resolveTrustTier", () => {
  describe("bundle format plugins", () => {
    for (const origin of ALL_ORIGINS) {
      it(`returns "content" for bundle format with origin "${origin}"`, () => {
        expect(resolveTrustTier({ format: "bundle", origin })).toBe("content");
      });
    }

    for (const bundleFormat of BUNDLE_FORMATS) {
      it(`returns "content" for bundleFormat "${bundleFormat}"`, () => {
        expect(
          resolveTrustTier({ format: "bundle", bundleFormat, origin: "global" }),
        ).toBe("content");
      });
    }

    it('returns "content" for bundle without bundleFormat', () => {
      expect(resolveTrustTier({ format: "bundle", origin: "workspace" })).toBe(
        "content",
      );
    });
  });

  describe("openclaw format plugins", () => {
    for (const origin of ALL_ORIGINS) {
      it(`returns "native" for openclaw format with origin "${origin}"`, () => {
        expect(resolveTrustTier({ format: "openclaw", origin })).toBe("native");
      });
    }
  });

  describe("undefined format (safe fallback)", () => {
    it('returns "content" when format is undefined', () => {
      expect(resolveTrustTier({ origin: "global" })).toBe("content");
    });

    for (const origin of ALL_ORIGINS) {
      it(`returns "content" for undefined format with origin "${origin}"`, () => {
        expect(resolveTrustTier({ format: undefined, origin })).toBe("content");
      });
    }
  });
});
