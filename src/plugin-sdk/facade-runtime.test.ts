import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
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
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const FACADE_RUNTIME_GLOBAL = "__openclawTestLoadBundledPluginPublicSurfaceModuleSync";

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
      `const loadBundledPluginPublicSurfaceModuleSync = globalThis.${FACADE_RUNTIME_GLOBAL};`,
      `if (typeof loadBundledPluginPublicSurfaceModuleSync !== "function") {`,
      '  throw new Error("missing facade runtime test loader");',
      "}",
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
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  vi.doUnmock("../plugins/manifest-registry.js");
  delete (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_RUNTIME_GLOBAL];
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
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
    (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_RUNTIME_GLOBAL] =
      loadBundledPluginPublicSurfaceModuleSync;

    const loaded = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("circular-ok");
  });

  it("back-fills the sentinel before post-load facade tracking re-enters", async () => {
    const dir = createBundledPluginDir("openclaw-facade-post-load-", "post-load-ok");
    const reentryMarkers: Array<string | undefined> = [];

    vi.resetModules();
    vi.doMock("../plugins/manifest-registry.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../plugins/manifest-registry.js")>();
      return {
        ...actual,
        loadPluginManifestRegistry: vi.fn(() => {
          const load = (
            globalThis as typeof globalThis & {
              [FACADE_RUNTIME_GLOBAL]?: typeof loadBundledPluginPublicSurfaceModuleSync;
            }
          )[FACADE_RUNTIME_GLOBAL];
          if (typeof load !== "function") {
            throw new Error("missing facade runtime test loader");
          }
          const reentered = load<{ marker?: string }>({
            dirName: "demo",
            artifactBasename: "api.js",
          });
          reentryMarkers.push(reentered.marker);
          return {
            plugins: [
              {
                id: "demo",
                rootDir: path.join(dir, "demo"),
                origin: "bundled",
              },
            ],
          };
        }),
      };
    });

    const facadeRuntime = await import("./facade-runtime.js");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
    (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_RUNTIME_GLOBAL] =
      facadeRuntime.loadBundledPluginPublicSurfaceModuleSync;

    const loaded = facadeRuntime.loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("post-load-ok");
    expect(reentryMarkers.length).toBeGreaterThan(0);
    expect(reentryMarkers.every((marker) => marker === "post-load-ok")).toBe(true);
    expect(facadeRuntime.listImportedBundledPluginFacadeIds()).toEqual(["demo"]);
    facadeRuntime.resetFacadeRuntimeStateForTest();
    vi.doUnmock("../plugins/manifest-registry.js");
    vi.resetModules();
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

    expect(listImportedBundledPluginFacadeIds()).toEqual([]);

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

  it("resolves a globally-installed plugin whose rootDir basename matches the dirName", () => {
    // Simulate a global-only installation: the bundled plugins directory does
    // NOT contain the target plugin, but a global extensions directory does.
    // The facade module location resolver should fall through to the registry-
    // based lookup and find the module inside the global rootDir.
    const emptyBundled = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-facade-empty-bundled-"));
    tempDirs.push(emptyBundled);

    // Create a state dir whose "extensions" sub-directory acts as the global
    // plugin root (resolveConfigDir(env) + "/extensions").
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-facade-state-"));
    tempDirs.push(stateDir);
    const lineDir = path.join(stateDir, "extensions", "line");
    fs.mkdirSync(lineDir, { recursive: true });
    fs.writeFileSync(
      path.join(lineDir, "runtime-api.js"),
      'export const marker = "global-line";\n',
      "utf8",
    );
    // Discovery reads package.json (not openclaw.plugin.json) and looks for
    // the "openclaw" key to resolve extension entries.
    fs.writeFileSync(
      path.join(lineDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/line",
        version: "0.0.0",
        openclaw: {
          extensions: ["./runtime-api.js"],
          channel: { id: "line" },
        },
      }),
      "utf8",
    );
    // The plugin manifest (openclaw.plugin.json) is loaded separately by the
    // registry builder to populate id, channels, etc.
    fs.writeFileSync(
      path.join(lineDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "line",
        channels: ["line"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = emptyBundled;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
    resetFacadeRuntimeStateForTest();

    setRuntimeConfigSnapshot({
      channels: {
        line: {
          enabled: true,
        },
      },
    });

    // The plugin should be resolvable via the registry fallback even though
    // the bundled plugins directory is empty.
    expect(
      canLoadActivatedBundledPluginPublicSurface({
        dirName: "line",
        artifactBasename: "runtime-api.js",
      }),
    ).toBe(true);
  });

  it("resolves a globally-installed plugin with an encoded scoped rootDir basename", () => {
    // When a scoped package like @openclaw/line is installed globally, its
    // directory name is encoded (e.g. "@openclaw+line").  The rootDir basename
    // no longer matches the facade dirName "line", so the resolver must fall
    // back to matching by plugin.id or plugin.channels.
    const emptyBundled = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-facade-empty-bundled-"));
    tempDirs.push(emptyBundled);

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-facade-state-"));
    tempDirs.push(stateDir);
    // Use the encoded scoped package directory name.
    const encodedDir = path.join(stateDir, "extensions", "@openclaw+line");
    fs.mkdirSync(encodedDir, { recursive: true });
    fs.writeFileSync(
      path.join(encodedDir, "runtime-api.js"),
      'export const marker = "encoded-global-line";\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(encodedDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/line",
        version: "0.0.0",
        openclaw: {
          extensions: ["./runtime-api.js"],
          channel: { id: "line" },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(encodedDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "line",
        channels: ["line"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = emptyBundled;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
    resetFacadeRuntimeStateForTest();

    setRuntimeConfigSnapshot({
      channels: {
        line: {
          enabled: true,
        },
      },
    });

    // The plugin.id fallback must resolve the plugin even though
    // path.basename(rootDir) is "@openclaw+line", not "line".
    expect(
      canLoadActivatedBundledPluginPublicSurface({
        dirName: "line",
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
