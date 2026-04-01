import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSiblingRuntimeModuleSync } from "./local-runtime-module.js";

const tempDirs = new Set<string>();

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-runtime-module-"));
  tempDirs.add(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("loadSiblingRuntimeModuleSync", () => {
  it("loads a sibling runtime module from the caller directory", () => {
    const root = createTempDir();
    const moduleUrl = pathToFileURL(
      path.join(root, "src", "plugins", "runtime", "runtime-line.js"),
    ).href;

    writeFile(
      path.join(root, "src", "plugins", "runtime", "runtime-line.contract.js"),
      "module.exports = { runtimeLine: { source: 'sibling' } };",
    );

    const loaded = loadSiblingRuntimeModuleSync<{ runtimeLine: { source: string } }>({
      moduleUrl,
      relativeBase: "./runtime-line.contract",
    });

    expect(loaded.runtimeLine.source).toBe("sibling");
  });

  it("falls back to the built plugins/runtime dist layout", () => {
    const root = createTempDir();
    const moduleUrl = pathToFileURL(path.join(root, "dist", "runtime-9DLN_Ai5.js")).href;

    writeFile(
      path.join(root, "dist", "plugins", "runtime", "runtime-line.contract.js"),
      "module.exports = { runtimeLine: { source: 'dist-runtime' } };",
    );

    const loaded = loadSiblingRuntimeModuleSync<{ runtimeLine: { source: string } }>({
      moduleUrl,
      relativeBase: "./runtime-line.contract",
    });

    expect(loaded.runtimeLine.source).toBe("dist-runtime");
  });

  it("throws when no candidate runtime module exists", () => {
    const root = createTempDir();
    const moduleUrl = pathToFileURL(path.join(root, "dist", "runtime-9DLN_Ai5.js")).href;

    expect(() =>
      loadSiblingRuntimeModuleSync({
        moduleUrl,
        relativeBase: "./runtime-line.contract",
      }),
    ).toThrow("Unable to resolve runtime module ./runtime-line.contract");
  });
});
