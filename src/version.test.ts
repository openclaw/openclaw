import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readVersionFromBuildInfoForModuleUrl,
  readVersionFromPackageJsonForModuleUrl,
  resolveVersionFromModuleUrl,
} from "./version.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-version-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function moduleUrlFrom(root: string, relativePath: string): string {
  return pathToFileURL(path.join(root, relativePath)).href;
}

describe("version resolution", () => {
  it("resolves package version from nested dist/plugin-sdk module URL", async () => {
    await withTempDir(async (root) => {
      await fs.mkdir(path.join(root, "dist", "plugin-sdk"), { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.2.3" }),
        "utf-8",
      );

      const moduleUrl = moduleUrlFrom(root, "dist/plugin-sdk/index.js");
      expect(readVersionFromPackageJsonForModuleUrl(moduleUrl)).toBe("1.2.3");
      expect(resolveVersionFromModuleUrl(moduleUrl)).toBe("1.2.3");
    });
  });

  it("ignores unrelated nearby package.json files", async () => {
    await withTempDir(async (root) => {
      await fs.mkdir(path.join(root, "dist", "plugin-sdk"), { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2.3.4" }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(root, "dist", "package.json"),
        JSON.stringify({ name: "other-package", version: "9.9.9" }),
        "utf-8",
      );

      const moduleUrl = moduleUrlFrom(root, "dist/plugin-sdk/index.js");
      expect(readVersionFromPackageJsonForModuleUrl(moduleUrl)).toBe("2.3.4");
    });
  });

  it("falls back to build-info when package metadata is unavailable", async () => {
    await withTempDir(async (root) => {
      await fs.mkdir(path.join(root, "dist", "plugin-sdk"), { recursive: true });
      await fs.writeFile(
        path.join(root, "build-info.json"),
        JSON.stringify({ version: "4.5.6" }),
        "utf-8",
      );

      const moduleUrl = moduleUrlFrom(root, "dist/plugin-sdk/index.js");
      expect(readVersionFromPackageJsonForModuleUrl(moduleUrl)).toBeNull();
      expect(readVersionFromBuildInfoForModuleUrl(moduleUrl)).toBe("4.5.6");
      expect(resolveVersionFromModuleUrl(moduleUrl)).toBe("4.5.6");
    });
  });

  it("returns null when no version metadata exists", async () => {
    await withTempDir(async (root) => {
      await fs.mkdir(path.join(root, "dist", "plugin-sdk"), { recursive: true });

      const moduleUrl = moduleUrlFrom(root, "dist/plugin-sdk/index.js");
      expect(readVersionFromPackageJsonForModuleUrl(moduleUrl)).toBeNull();
      expect(readVersionFromBuildInfoForModuleUrl(moduleUrl)).toBeNull();
      expect(resolveVersionFromModuleUrl(moduleUrl)).toBeNull();
    });
  });
});
