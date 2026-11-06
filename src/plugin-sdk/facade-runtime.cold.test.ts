import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { createNodeEvalArgs } from "../test-utils/node-process.js";
import {
  listImportedBundledPluginFacadeIds,
  loadActivatedBundledPluginPublicSurfaceModule,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
import { writeFacadeFiles } from "./facade-runtime.test-support.js";

const moduleUrl = (file: string) => pathToFileURL(path.resolve(file)).href;

const fixtureLifetime = createFixtureLifetime();
afterEach(() => fixtureLifetime.cleanup());

function createFacade(id: string) {
  const bundledRoot = path.resolve("dist-runtime", "extensions");
  fs.mkdirSync(bundledRoot, { recursive: true });
  const root = fs.realpathSync(fixtureLifetime.createTempDir(".cold-facade-", bundledRoot));
  writeFacadeFiles(path.join(root, "fixture"), {
    "package.json": { type: "module" },
    "openclaw.plugin.json": { id, enabledByDefault: true },
    "api.ts": 'export const marker: string = "cold";\n',
  });
  return root;
}

it("awaits cold activation before loading a tiny allowed source facade", async () => {
  const root = createFacade("async-cold-owner");
  resetFacadeRuntimeStateForTest();
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", root);
  try {
    const pending = loadActivatedBundledPluginPublicSurfaceModule({
      dirName: "fixture",
      artifactBasename: "api.js",
    });
    expect(listImportedBundledPluginFacadeIds()).toEqual([]);
    await expect(pending).resolves.toEqual({ marker: "cold" });
    expect(listImportedBundledPluginFacadeIds()).toEqual(["async-cold-owner"]);
  } finally {
    resetFacadeRuntimeStateForTest();
    vi.unstubAllEnvs();
  }
});

it("uses the live snapshot during cold synchronous activation", async ({ signal }) => {
  const fixtureRoot = createFacade("cold-native-owner");
  const isolatedRoot = fixtureLifetime.createTempDir("openclaw-cold-native-facade-");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    HOME: isolatedRoot,
    USERPROFILE: isolatedRoot,
    TMPDIR: isolatedRoot,
    TMP: isolatedRoot,
    TEMP: isolatedRoot,
    OPENCLAW_HOME: isolatedRoot,
    OPENCLAW_STATE_DIR: path.join(isolatedRoot, "state"),
    OPENCLAW_CONFIG_PATH: path.join(isolatedRoot, "missing-config.json"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: fixtureRoot,
    XDG_CONFIG_HOME: path.join(isolatedRoot, "config"),
    XDG_CACHE_HOME: path.join(isolatedRoot, "cache"),
    XDG_DATA_HOME: path.join(isolatedRoot, "data"),
    JITI_FS_CACHE: "0",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
  const source = `
    import assert from "node:assert/strict";
    const { setRuntimeConfigSnapshot } = await import(${JSON.stringify(moduleUrl("src/config/runtime-snapshot.ts"))});
    const { loadActivatedBundledPluginPublicSurfaceModuleSync: load, listImportedBundledPluginFacadeIds } = await import(${JSON.stringify(moduleUrl("src/plugin-sdk/facade-runtime.ts"))});
    const params = { dirName: "fixture", artifactBasename: "api.js" };
    const disabled = { plugins: { entries: { "cold-native-owner": { enabled: false } } } };
    setRuntimeConfigSnapshot(disabled);
    assert.throws(() => load(params), /disabled in config/);
    assert.deepEqual(listImportedBundledPluginFacadeIds(), []);
    setRuntimeConfigSnapshot({});
    const loaded = load(params);
    assert.equal(loaded.marker, "cold");
    assert.strictEqual(load(params), loaded);
    setRuntimeConfigSnapshot(disabled);
    assert.throws(() => load(params), /disabled in config/);
    console.log("cold facade follows the native source config snapshot");
    process.exit(0);
  `;
  const result = await fixtureLifetime.track(
    runNodeScript(
      createNodeEvalArgs(source, {
        imports: [moduleUrl("scripts/tsx.mjs")],
      }),
      env,
      30_000,
      {
        cwd: process.cwd(),
        signal,
        requireProcessTreeExit: process.platform !== "win32",
        maxBuffer: 64 * 1024,
      },
    ),
  );
  expect(
    [result.error, result.status],
    `Child inputs: ${fixtureRoot}; ${isolatedRoot}\n${result.stderr}`,
  ).toEqual([undefined, 0]);
  expect(result.stdout.trim()).toBe("cold facade follows the native source config snapshot");
});
