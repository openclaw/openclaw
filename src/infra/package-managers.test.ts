import { describe, expect, it } from "vitest";
import {
  detectLinuxDistroFamily,
  getAvailablePackageManagers,
  getNativePackageManager,
  hasPackageManager,
} from "./package-managers.js";

describe("package-managers", () => {
  describe("detectLinuxDistroFamily", () => {
    it("returns unknown on non-Linux platforms", () => {
      if (process.platform !== "linux") {
        expect(detectLinuxDistroFamily()).toBe("unknown");
      }
    });

    it("detects Linux distro family on Linux", () => {
      if (process.platform === "linux") {
        const family = detectLinuxDistroFamily();
        expect(family).toMatch(/^(debian|rhel|arch|alpine|unknown)$/);
      }
    });
  });

  describe("hasPackageManager", () => {
    it("checks for package manager availability", () => {
      // These should always return boolean
      expect(typeof hasPackageManager("brew")).toBe("boolean");
      expect(typeof hasPackageManager("apt")).toBe("boolean");
      expect(typeof hasPackageManager("npm")).toBe("boolean");
    });

    it("returns false for non-existent package managers on current platform", () => {
      // On most systems, at least one of these won't be available
      const results = [
        hasPackageManager("pacman"),
        hasPackageManager("apk"),
        hasPackageManager("dnf"),
      ];
      // At least one should be false (unless running on a very unusual system)
      expect(results.some((r) => !r)).toBe(true);
    });
  });

  describe("getNativePackageManager", () => {
    it("returns appropriate package manager for current platform", () => {
      const native = getNativePackageManager();

      if (process.platform === "darwin") {
        // On macOS, should return brew if available, otherwise undefined
        if (native) {
          expect(native).toBe("brew");
        }
      } else if (process.platform === "linux") {
        // On Linux, should return one of the native package managers or undefined
        if (native) {
          expect(["apt", "dnf", "pacman", "apk"]).toContain(native);
        }
      }
    });
  });

  describe("getAvailablePackageManagers", () => {
    it("returns an array of available package managers", () => {
      const available = getAvailablePackageManagers();
      expect(Array.isArray(available)).toBe(true);

      // Should contain only valid package manager names
      const validPMs = [
        "brew",
        "apt",
        "dnf",
        "pacman",
        "apk",
        "npm",
        "pnpm",
        "yarn",
        "bun",
        "go",
        "uv",
      ];
      for (const pm of available) {
        expect(validPMs).toContain(pm);
      }
    });

    it("returns package managers in priority order", () => {
      const available = getAvailablePackageManagers();

      // On macOS, brew should come first if available
      if (process.platform === "darwin" && available.includes("brew")) {
        expect(available[0]).toBe("brew");
      }

      // On Linux, native PM should come before brew
      if (process.platform === "linux") {
        const nativeIndex = available.findIndex((pm) =>
          ["apt", "dnf", "pacman", "apk"].includes(pm),
        );
        const brewIndex = available.indexOf("brew");

        if (nativeIndex !== -1 && brewIndex !== -1) {
          expect(nativeIndex).toBeLessThan(brewIndex);
        }
      }
    });
  });
});
