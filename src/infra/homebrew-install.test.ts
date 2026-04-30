import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  detectHomebrewInstall,
  extractHomebrewCellarVersion,
  isHomebrewManagedRootPath,
} from "./homebrew-install.js";

describe("homebrew-install", () => {
  describe("isHomebrewManagedRootPath", () => {
    it("matches a macOS Cellar-style openclaw root", () => {
      expect(
        isHomebrewManagedRootPath(
          "/opt/homebrew/Cellar/openclaw/2026.4.25/libexec/lib/node_modules/openclaw",
        ),
      ).toBe(true);
    });

    it("matches an Intel /usr/local Cellar-style openclaw root", () => {
      expect(
        isHomebrewManagedRootPath(
          "/usr/local/Cellar/openclaw/2026.4.25/libexec/lib/node_modules/openclaw",
        ),
      ).toBe(true);
    });

    it("matches a Linuxbrew Cellar-style openclaw root", () => {
      expect(
        isHomebrewManagedRootPath(
          "/home/linuxbrew/.linuxbrew/Cellar/openclaw/2026.4.25/libexec/lib/node_modules/openclaw",
        ),
      ).toBe(true);
    });

    it("matches the opt symlink layout", () => {
      expect(
        isHomebrewManagedRootPath("/opt/homebrew/opt/openclaw/libexec/lib/node_modules/openclaw"),
      ).toBe(true);
    });

    it("rejects a vanilla npm global install", () => {
      expect(isHomebrewManagedRootPath("/opt/homebrew/lib/node_modules/openclaw")).toBe(false);
      expect(isHomebrewManagedRootPath("/usr/lib/node_modules/openclaw")).toBe(false);
      expect(isHomebrewManagedRootPath("/Users/sanjay/.npm-global/lib/node_modules/openclaw")).toBe(
        false,
      );
    });

    it("rejects empty input", () => {
      expect(isHomebrewManagedRootPath("")).toBe(false);
    });

    it("matches Windows-style Cellar paths", () => {
      expect(
        isHomebrewManagedRootPath(
          "C:\\opt\\homebrew\\Cellar\\openclaw\\2026.4.25\\libexec\\lib\\node_modules\\openclaw",
        ),
      ).toBe(true);
    });
  });

  describe("extractHomebrewCellarVersion", () => {
    it("extracts the version segment from Cellar paths", () => {
      expect(
        extractHomebrewCellarVersion(
          "/opt/homebrew/Cellar/openclaw/2026.4.25/libexec/lib/node_modules/openclaw",
        ),
      ).toBe("2026.4.25");
    });

    it("returns undefined for non-Cellar paths", () => {
      expect(
        extractHomebrewCellarVersion(
          "/opt/homebrew/opt/openclaw/libexec/lib/node_modules/openclaw",
        ),
      ).toBeUndefined();
      expect(
        extractHomebrewCellarVersion("/opt/homebrew/lib/node_modules/openclaw"),
      ).toBeUndefined();
      expect(extractHomebrewCellarVersion("")).toBeUndefined();
    });
  });

  describe("detectHomebrewInstall", () => {
    it("returns null for empty input", async () => {
      await expect(detectHomebrewInstall({ packageRoot: null })).resolves.toBeNull();
      await expect(detectHomebrewInstall({ packageRoot: "" })).resolves.toBeNull();
    });

    it("matches a Cellar-style realpath and returns the version", async () => {
      await withTempDir({ prefix: "openclaw-brew-detect-" }, async (tmp) => {
        const cellarRoot = path.join(
          tmp,
          "Cellar",
          "openclaw",
          "2026.4.25",
          "libexec",
          "lib",
          "node_modules",
          "openclaw",
        );
        await fs.mkdir(cellarRoot, { recursive: true });
        const info = await detectHomebrewInstall({ packageRoot: cellarRoot, env: {} });
        expect(info).not.toBeNull();
        expect(info?.cellarVersion).toBe("2026.4.25");
        expect(info?.resolvedRoot).toContain("Cellar");
      });
    });

    it("matches via the opt symlink even when realpath resolves into Cellar", async () => {
      await withTempDir({ prefix: "openclaw-brew-detect-" }, async (tmp) => {
        const cellarRoot = path.join(
          tmp,
          "Cellar",
          "openclaw",
          "2026.4.25",
          "libexec",
          "lib",
          "node_modules",
          "openclaw",
        );
        await fs.mkdir(cellarRoot, { recursive: true });
        const optDir = path.join(tmp, "opt");
        await fs.mkdir(optDir, { recursive: true });
        const optLink = path.join(optDir, "openclaw");
        await fs.symlink(path.join(tmp, "Cellar", "openclaw", "2026.4.25"), optLink);
        const optRoot = path.join(optLink, "libexec", "lib", "node_modules", "openclaw");
        const info = await detectHomebrewInstall({ packageRoot: optRoot, env: {} });
        expect(info).not.toBeNull();
        // We follow realpath so cellarVersion is populated even when the input
        // was the opt symlink.
        expect(info?.cellarVersion).toBe("2026.4.25");
      });
    });

    it("returns null for a vanilla npm global install", async () => {
      await withTempDir({ prefix: "openclaw-brew-detect-" }, async (tmp) => {
        const npmRoot = path.join(tmp, "lib", "node_modules", "openclaw");
        await fs.mkdir(npmRoot, { recursive: true });
        await expect(detectHomebrewInstall({ packageRoot: npmRoot, env: {} })).resolves.toBeNull();
      });
    });

    it("does not throw if the root does not exist on disk", async () => {
      const ghost = "/opt/homebrew/Cellar/openclaw/0.0.0/libexec/lib/node_modules/openclaw";
      const info = await detectHomebrewInstall({ packageRoot: ghost, env: {} });
      // Even when realpath fails, the literal Cellar path should still match.
      expect(info).not.toBeNull();
      expect(info?.cellarVersion).toBe("0.0.0");
    });
  });
});
