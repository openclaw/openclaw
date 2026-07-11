import { afterEach, describe, expect, it } from "vitest";

const originalPlatform = process.platform;

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
});

import { toSafeImportPath } from "./import-specifier.js";

describe("toSafeImportPath", () => {
  describe("on non-Windows platforms", () => {
    it("returns the specifier unchanged", () => {
      setPlatform("darwin");
      expect(toSafeImportPath("/absolute/path.js")).toBe("/absolute/path.js");
      expect(toSafeImportPath("./relative/path.js")).toBe("./relative/path.js");
      expect(toSafeImportPath("C:\\windows\\path.js")).toBe("C:\\windows\\path.js");
    });
  });

  describe("on Windows", () => {
    it("returns already-file:// URLs unchanged", () => {
      setPlatform("win32");
      expect(toSafeImportPath("file:///C:/foo/bar.js")).toBe("file:///C:/foo/bar.js");
    });

    it("converts absolute Windows paths to file:// URLs", () => {
      setPlatform("win32");
      expect(toSafeImportPath("C:\\Users\\test\\module.js")).toBe(
        "file:///C:/Users/test/module.js",
      );
    });

    it("returns relative paths unchanged", () => {
      setPlatform("win32");
      expect(toSafeImportPath("./relative/module.js")).toBe("./relative/module.js");
      expect(toSafeImportPath("../parent/module.js")).toBe("../parent/module.js");
    });
  });
});
