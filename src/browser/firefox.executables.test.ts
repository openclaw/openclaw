import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findFirefoxExecutableLinux,
  findFirefoxExecutableMac,
  findFirefoxExecutableWindows,
  resolveFirefoxExecutableForPlatform,
} from "./firefox.executables.js";

describe("firefox executables", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("macOS", () => {
    it("picks the first existing Firefox candidate", () => {
      const exists = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((p) => String(p).includes("Firefox.app/Contents/MacOS/firefox"));
      const exe = findFirefoxExecutableMac();
      expect(exe?.kind).toBe("firefox");
      expect(exe?.path).toMatch(/Firefox\.app\/Contents\/MacOS\/firefox$/);
      exists.mockRestore();
    });

    it("returns null when no Firefox candidate exists", () => {
      const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
      expect(findFirefoxExecutableMac()).toBeNull();
      exists.mockRestore();
    });

    it("detects Firefox Nightly", () => {
      const exists = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((p) => String(p).includes("Firefox Nightly.app"));
      const exe = findFirefoxExecutableMac();
      expect(exe?.kind).toBe("firefox-nightly");
      exists.mockRestore();
    });

    it("detects Firefox Developer Edition", () => {
      const exists = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((p) => String(p).includes("Firefox Developer Edition.app"));
      const exe = findFirefoxExecutableMac();
      expect(exe?.kind).toBe("firefox-dev");
      exists.mockRestore();
    });
  });

  describe("Linux", () => {
    it("picks /usr/bin/firefox when available", () => {
      const exists = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((p) => String(p) === "/usr/bin/firefox");
      const exe = findFirefoxExecutableLinux();
      expect(exe?.kind).toBe("firefox");
      expect(exe?.path).toBe("/usr/bin/firefox");
      exists.mockRestore();
    });

    it("picks firefox-esr when standard is missing", () => {
      const exists = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((p) => String(p) === "/usr/bin/firefox-esr");
      const exe = findFirefoxExecutableLinux();
      expect(exe?.kind).toBe("firefox");
      expect(exe?.path).toBe("/usr/bin/firefox-esr");
      exists.mockRestore();
    });

    it("picks snap firefox when others are missing", () => {
      const exists = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((p) => String(p) === "/snap/bin/firefox");
      const exe = findFirefoxExecutableLinux();
      expect(exe?.kind).toBe("firefox");
      expect(exe?.path).toBe("/snap/bin/firefox");
      exists.mockRestore();
    });

    it("returns null when no Firefox candidate exists", () => {
      const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
      expect(findFirefoxExecutableLinux()).toBeNull();
      exists.mockRestore();
    });
  });

  describe("Windows", () => {
    it("finds Firefox in Program Files", () => {
      const exists = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((p) => String(p).includes("Mozilla Firefox"));
      const exe = findFirefoxExecutableWindows();
      expect(exe?.kind).toBe("firefox");
      expect(exe?.path).toMatch(/firefox\.exe$/);
      exists.mockRestore();
    });

    it("returns null when no Firefox candidate exists on Windows", () => {
      const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
      expect(findFirefoxExecutableWindows()).toBeNull();
      exists.mockRestore();
    });

    it("detects Firefox Nightly on Windows", () => {
      const exists = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((p) => String(p).includes("Firefox Nightly"));
      const exe = findFirefoxExecutableWindows();
      expect(exe?.kind).toBe("firefox-nightly");
      expect(exe?.path).toMatch(/firefox\.exe$/);
      exists.mockRestore();
    });
  });

  describe("resolveFirefoxExecutableForPlatform", () => {
    it("delegates to macOS finder for darwin", () => {
      const exists = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((p) => String(p).includes("Firefox.app/Contents/MacOS/firefox"));
      const exe = resolveFirefoxExecutableForPlatform("darwin");
      expect(exe?.kind).toBe("firefox");
      exists.mockRestore();
    });

    it("delegates to Linux finder for linux", () => {
      const exists = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((p) => String(p) === "/usr/bin/firefox");
      const exe = resolveFirefoxExecutableForPlatform("linux");
      expect(exe?.kind).toBe("firefox");
      exists.mockRestore();
    });

    it("delegates to Windows finder for win32", () => {
      const exists = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((p) => String(p).includes("Mozilla Firefox"));
      const exe = resolveFirefoxExecutableForPlatform("win32");
      expect(exe?.kind).toBe("firefox");
      exists.mockRestore();
    });

    it("returns null for unsupported platforms", () => {
      expect(resolveFirefoxExecutableForPlatform("freebsd" as NodeJS.Platform)).toBeNull();
    });
  });
});
