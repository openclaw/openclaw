import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

const tempDirs: string[] = [];
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const FACADE_RUNTIME_MODULE_PATH = fileURLToPath(new URL("./facade-runtime.ts", import.meta.url));

function createBundledPluginDir(prefix: string, marker: string): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(rootDir);
  fs.mkdirSync(path.join(rootDir, "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "demo", "api.js"),
    `export const marker = ${JSON.stringify(marker)};\n`,
    "utf8",
  );
  return rootDir;
}

function createReentrantBundledPluginDir(prefix: string): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(rootDir);
  fs.mkdirSync(path.join(rootDir, "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "demo", "api.js"),
    [
      `import { loadBundledPluginPublicSurfaceModuleSync } from ${JSON.stringify(FACADE_RUNTIME_MODULE_PATH)};`,
      `export const recurse = loadBundledPluginPublicSurfaceModuleSync({ dirName: "demo", artifactBasename: "api.js" });`,
      `export const marker = "reentrant-ok";`,
      "",
    ].join("\n"),
    "utf8",
  );
  return rootDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin-sdk facade runtime", () => {
  it("honors bundled plugin dir overrides outside the package root", () => {
    const overrideA = createBundledPluginDir("openclaw-facade-runtime-a-", "override-a");
    const overrideB = createBundledPluginDir("openclaw-facade-runtime-b-", "override-b");

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = overrideA;
    const fromA = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    expect(fromA.marker).toBe("override-a");

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = overrideB;
    const fromB = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    expect(fromB.marker).toBe("override-b");
  });

  it("returns a placeholder during reentrant facade loads instead of recursing forever", () => {
    const override = createReentrantBundledPluginDir("openclaw-facade-runtime-reentrant-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = override;

    const loaded = loadBundledPluginPublicSurfaceModuleSync<{
      marker: string;
      recurse: { marker: string };
    }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("reentrant-ok");
    expect(loaded.recurse.marker).toBe("reentrant-ok");
  });
});
