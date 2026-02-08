import { describe, expect, it } from "vitest";
import { DEFAULT_CAUTION_TOOLS, isToolCautioned } from "./caution-defaults.js";

describe("caution-defaults", () => {
  describe("DEFAULT_CAUTION_TOOLS", () => {
    it("marks web_fetch as cautioned", () => {
      expect(DEFAULT_CAUTION_TOOLS.web_fetch).toBe(true);
    });

    it("marks web_search as not cautioned", () => {
      expect(DEFAULT_CAUTION_TOOLS.web_search).toBe(false);
    });

    it("marks browser as cautioned", () => {
      expect(DEFAULT_CAUTION_TOOLS.browser).toBe(true);
    });
  });

  describe("isToolCautioned", () => {
    it("returns false when caution is disabled", () => {
      expect(isToolCautioned("web_fetch", { enabled: false })).toBe(false);
    });

    it("returns true for web_fetch by default", () => {
      expect(isToolCautioned("web_fetch")).toBe(true);
    });

    it("returns false for web_search by default", () => {
      expect(isToolCautioned("web_search")).toBe(false);
    });

    it("returns false for unknown tools", () => {
      expect(isToolCautioned("unknown_tool")).toBe(false);
    });

    it("respects config override to enable", () => {
      expect(
        isToolCautioned("web_search", {
          enabled: true,
          tools: { web_search: true },
        }),
      ).toBe(true);
    });

    it("respects config override to disable", () => {
      expect(
        isToolCautioned("web_fetch", {
          enabled: true,
          tools: { web_fetch: false },
        }),
      ).toBe(false);
    });

    it("respects plugin metadata", () => {
      expect(
        isToolCautioned("custom_tool", { enabled: true }, { caution: true }),
      ).toBe(true);
    });

    it("prefers config override over plugin metadata", () => {
      expect(
        isToolCautioned(
          "custom_tool",
          { enabled: true, tools: { custom_tool: false } },
          { caution: true },
        ),
      ).toBe(false);
    });

    it("prefers plugin metadata over defaults", () => {
      expect(
        isToolCautioned("web_search", { enabled: true }, { caution: true }),
      ).toBe(true);
    });
  });
});
