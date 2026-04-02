import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  canLoadActivatedBundledPluginPublicSurface,
  listImportedBundledPluginFacadeIds,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
  loadBundledPluginPublicSurfaceModuleSync,
  resetFacadeRuntimeStateForTest,
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

const tempDirs: string[] = [];
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

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

function createThrowingPluginDir(prefix: string): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(rootDir);
  fs.mkdirSync(path.join(rootDir, "bad"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "bad", "api.js"),
    `throw new Error("plugin load failure");\n`,
    "utf8",
  );
  return rootDir;
}

function createCircularPluginDir(prefix: string): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(rootDir);
  fs.mkdirSync(path.join(rootDir, "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "facade.mjs"),
    [
      `import { loadBundledPluginPublicSurfaceModuleSync } from ${JSON.stringify(
        new URL("./facade-runtime.js", import.meta.url).href,
      )};`,
      `export const marker = loadBundledPluginPublicSurfaceModuleSync({ dirName: "demo", artifactBasename: "api.js" }).marker;`,
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "demo", "helper.js"),
    ['import { marker } from "../facade.mjs";', "export const circularMarker = marker;", ""].join(
      "\n",
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "demo", "api.js"),
    ['import "./helper.js";', 'export const marker = "circular-ok";', ""].join("\n"),
    "utf8",
  );
  return rootDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetFacadeRuntimeStateForTest();
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

  it("returns the same object identity on repeated calls (sentinel consistency)", () => {
    const dir = createBundledPluginDir("openclaw-facade-identity-", "identity-check");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;

    const first = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    const second = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    expect(first).toBe(second);
    expect(first.marker).toBe("identity-check");
    expect(listImportedBundledPluginFacadeIds()).toEqual(["demo"]);
  });

  it("breaks circular facade re-entry during module evaluation", () => {
    const dir = createCircularPluginDir("openclaw-facade-circular-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;

    const loaded = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("circular-ok");
  });

  it("clears the cache on load failure so retries re-execute", () => {
    const dir = createThrowingPluginDir("openclaw-facade-throw-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;

    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        dirName: "bad",
        artifactBasename: "api.js",
      }),
    ).toThrow("plugin load failure");

    // A second call must also throw (not return a stale empty sentinel).
    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        dirName: "bad",
        artifactBasename: "api.js",
      }),
    ).toThrow("plugin load failure");
  });

  it("blocks runtime-api facade loads for bundled plugins that are not activated", () => {
    setRuntimeConfigSnapshot({});

    expect(
      canLoadActivatedBundledPluginPublicSurface({
        dirName: "discord",
        artifactBasename: "runtime-api.js",
      }),
    ).toBe(false);
    expect(() =>
      loadActivatedBundledPluginPublicSurfaceModuleSync({
        dirName: "discord",
        artifactBasename: "runtime-api.js",
      }),
    ).toThrow(/Bundled plugin public surface access blocked/);
    expect(
      tryLoadActivatedBundledPluginPublicSurfaceModuleSync({
        dirName: "discord",
        artifactBasename: "runtime-api.js",
      }),
    ).toBeNull();
  });

  it("allows runtime-api facade loads when the bundled plugin is explicitly enabled", () => {
    setRuntimeConfigSnapshot({
      plugins: {
        entries: {
          discord: {
            enabled: true,
          },
        },
      },
    });

    expect(
      canLoadActivatedBundledPluginPublicSurface({
        dirName: "discord",
        artifactBasename: "runtime-api.js",
      }),
    ).toBe(true);
  });

  it("keeps shared runtime-core facades available without plugin activation", () => {
    setRuntimeConfigSnapshot({});

    expect(
      canLoadActivatedBundledPluginPublicSurface({
        dirName: "speech-core",
        artifactBasename: "runtime-api.js",
      }),
    ).toBe(true);
    expect(
      canLoadActivatedBundledPluginPublicSurface({
        dirName: "image-generation-core",
        artifactBasename: "runtime-api.js",
      }),
    ).toBe(true);
    expect(
      canLoadActivatedBundledPluginPublicSurface({
        dirName: "media-understanding-core",
        artifactBasename: "runtime-api.js",
      }),
    ).toBe(true);
  });
});
