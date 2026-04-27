import { describe, expect, it, vi } from "vitest";
import { toSafeImportPath } from "./safe-import-path.js";

describe("toSafeImportPath", () => {
  describe("on win32", () => {
    function withWin32<T>(fn: () => T): T {
      const spy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        return fn();
      } finally {
        spy.mockRestore();
      }
    }

    it("converts a drive-letter absolute path to a file:/// URL", () => {
      withWin32(() => {
        expect(toSafeImportPath("C:\\Users\\alice\\plugin\\index.mjs")).toBe(
          "file:///C:/Users/alice/plugin/index.mjs",
        );
      });
    });

    it("converts a UNC path to a file:// URL", () => {
      withWin32(() => {
        expect(toSafeImportPath("\\\\server\\share\\plugin\\index.mjs")).toBe(
          "file://server/share/plugin/index.mjs",
        );
      });
    });

    it("encodes spaces and unicode in the path", () => {
      withWin32(() => {
        expect(toSafeImportPath("C:\\Users\\Ada Lovelace\\café\\index.mjs")).toBe(
          "file:///C:/Users/Ada%20Lovelace/caf%C3%A9/index.mjs",
        );
      });
    });

    it("leaves an existing file:// URL unchanged", () => {
      withWin32(() => {
        expect(toSafeImportPath("file:///C:/Users/alice/plugin/index.mjs")).toBe(
          "file:///C:/Users/alice/plugin/index.mjs",
        );
      });
    });

    it("leaves a relative specifier unchanged", () => {
      withWin32(() => {
        expect(toSafeImportPath("./relative/index.mjs")).toBe("./relative/index.mjs");
      });
    });

    it("leaves a bare module specifier unchanged", () => {
      withWin32(() => {
        expect(toSafeImportPath("some-package")).toBe("some-package");
      });
    });
  });

  describe("on non-win32 platforms", () => {
    function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
      const spy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      try {
        return fn();
      } finally {
        spy.mockRestore();
      }
    }

    it("returns posix absolute paths unchanged on linux", () => {
      withPlatform("linux", () => {
        expect(toSafeImportPath("/home/alice/plugin/index.mjs")).toBe(
          "/home/alice/plugin/index.mjs",
        );
      });
    });

    it("returns drive-letter input unchanged on darwin (no normalization off-Windows)", () => {
      withPlatform("darwin", () => {
        // We never see a literal drive-letter path on macOS in practice, but
        // the helper must be a strict no-op off Windows so that platform-specific
        // logic isn't accidentally exercised on the wrong host.
        expect(toSafeImportPath("C:\\foo\\bar.mjs")).toBe("C:\\foo\\bar.mjs");
      });
    });
  });
});
