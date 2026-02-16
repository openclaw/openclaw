import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActivePalette,
  getActiveThemeName,
  getThemeDescription,
  hasTheme,
  listThemeNames,
  onPaletteChange,
  setActiveTheme,
} from "./theme-registry.js";

describe("theme-registry", () => {
  afterEach(() => {
    // Reset to default theme after each test
    setActiveTheme("openclaw");
  });

  describe("getActivePalette", () => {
    it("should return the default openclaw palette", () => {
      const palette = getActivePalette();
      expect(palette.accent).toBe("#F6C453");
      expect(palette.text).toBe("#E8E3D5");
    });
  });

  describe("getActiveThemeName", () => {
    it("should return openclaw as default", () => {
      expect(getActiveThemeName()).toBe("openclaw");
    });

    it("should return the active theme after switching", () => {
      setActiveTheme("claude");
      expect(getActiveThemeName()).toBe("claude");
    });
  });

  describe("listThemeNames", () => {
    it("should list all built-in themes", () => {
      const names = listThemeNames();
      expect(names).toContain("openclaw");
      expect(names).toContain("claude");
      expect(names).toContain("monokai");
      expect(names).toContain("solarized-dark");
      expect(names).toContain("dracula");
      expect(names).toContain("minimal");
      expect(names).toContain("high-contrast");
      expect(names.length).toBe(7);
    });
  });

  describe("setActiveTheme", () => {
    it("should switch to a valid theme and return true", () => {
      const result = setActiveTheme("claude");
      expect(result).toBe(true);
      expect(getActiveThemeName()).toBe("claude");
      expect(getActivePalette().accent).toBe("#A78BFA");
    });

    it("should return false for an unknown theme", () => {
      const result = setActiveTheme("nonexistent");
      expect(result).toBe(false);
      expect(getActiveThemeName()).toBe("openclaw");
    });

    it("should switch between all available themes", () => {
      for (const name of listThemeNames()) {
        expect(setActiveTheme(name)).toBe(true);
        expect(getActiveThemeName()).toBe(name);
        const palette = getActivePalette();
        expect(palette.text).toBeTruthy();
        expect(palette.accent).toBeTruthy();
        expect(palette.error).toBeTruthy();
        expect(palette.success).toBeTruthy();
      }
    });
  });

  describe("onPaletteChange", () => {
    it("should notify listeners when theme changes", () => {
      const listener = vi.fn();
      const unsubscribe = onPaletteChange(listener);

      setActiveTheme("monokai");
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ accent: "#F92672" }),
        "monokai",
      );

      unsubscribe();
    });

    it("should not notify after unsubscribe", () => {
      const listener = vi.fn();
      const unsubscribe = onPaletteChange(listener);

      unsubscribe();
      setActiveTheme("dracula");
      expect(listener).not.toHaveBeenCalled();
    });

    it("should notify multiple listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = onPaletteChange(listener1);
      const unsub2 = onPaletteChange(listener2);

      setActiveTheme("minimal");
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);

      unsub1();
      unsub2();
    });
  });

  describe("hasTheme", () => {
    it("should return true for built-in themes", () => {
      expect(hasTheme("openclaw")).toBe(true);
      expect(hasTheme("claude")).toBe(true);
    });

    it("should return false for unknown themes", () => {
      expect(hasTheme("nonexistent")).toBe(false);
    });
  });

  describe("getThemeDescription", () => {
    it("should return descriptions for all built-in themes", () => {
      for (const name of listThemeNames()) {
        expect(getThemeDescription(name)).toBeTruthy();
      }
    });

    it("should return empty string for unknown themes", () => {
      expect(getThemeDescription("nonexistent")).toBe("");
    });
  });

  describe("palette completeness", () => {
    it("should have all required palette keys for each theme", () => {
      const requiredKeys = [
        "text",
        "dim",
        "accent",
        "accentSoft",
        "border",
        "userBg",
        "userText",
        "systemText",
        "toolPendingBg",
        "toolSuccessBg",
        "toolErrorBg",
        "toolTitle",
        "toolOutput",
        "quote",
        "quoteBorder",
        "code",
        "codeBlock",
        "codeBorder",
        "link",
        "error",
        "success",
      ];

      for (const name of listThemeNames()) {
        setActiveTheme(name);
        const palette = getActivePalette();
        for (const key of requiredKeys) {
          expect(palette[key as keyof typeof palette], `${name}.${key}`).toBeTruthy();
        }
      }
    });

    it("should have valid hex color values", () => {
      const hexPattern = /^#[0-9A-Fa-f]{6}$/;
      for (const name of listThemeNames()) {
        setActiveTheme(name);
        const palette = getActivePalette();
        for (const [key, value] of Object.entries(palette)) {
          expect(value, `${name}.${key}`).toMatch(hexPattern);
        }
      }
    });
  });
});
