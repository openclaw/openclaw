import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importExtensionHostPluginModule } from "./loader-import.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempPluginFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-loader-import-"));
  tempDirs.push(rootDir);
  const entryPath = path.join(rootDir, "index.js");
  fs.writeFileSync(entryPath, "export default {}");
  return { rootDir, entryPath };
}

describe("extension host loader import", () => {
  it("loads modules through a boundary-checked safe source path", () => {
    const { rootDir, entryPath } = createTempPluginFixture();
    const resolvedEntryPath = fs.realpathSync(entryPath);

    const result = importExtensionHostPluginModule({
      rootDir,
      source: entryPath,
      origin: "workspace",
      loadModule: (safeSource) => ({ safeSource }),
    });

    expect(result).toMatchObject({
      ok: true,
      module: {
        safeSource: resolvedEntryPath,
      },
      safeSource: resolvedEntryPath,
    });
  });

  it("rejects entry paths outside the plugin root", () => {
    const { rootDir } = createTempPluginFixture();
    const outsidePath = path.join(os.tmpdir(), `outside-${Date.now()}.js`);
    fs.writeFileSync(outsidePath, "export default {}");

    const result = importExtensionHostPluginModule({
      rootDir,
      source: outsidePath,
      origin: "workspace",
      loadModule: () => {
        throw new Error("should not run");
      },
    });

    fs.rmSync(outsidePath, { force: true });

    expect(result).toEqual({
      ok: false,
      message: "plugin entry path escapes plugin root or fails alias checks",
    });
  });

  it("returns load failures without throwing", () => {
    const { rootDir, entryPath } = createTempPluginFixture();
    const error = new Error("boom");

    const result = importExtensionHostPluginModule({
      rootDir,
      source: entryPath,
      origin: "workspace",
      loadModule: () => {
        throw error;
      },
    });

    expect(result).toEqual({
      ok: false,
      message: "failed to load plugin",
      error,
    });
  });
});
