import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { createNodeEvalArgs } from "../test-utils/node-process.js";
import {
  listImportedBundledPluginFacadeIds,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
  loadBundledPluginPublicSurfaceModuleSync,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";

describe("cold facade runtime", () => {
  const fixtureLifetime = createFixtureLifetime();
  afterEach(() => fixtureLifetime.cleanup());

  it("loads and tracks a light source facade without prewarming workspace dependencies", () => {
    const bundledRoot = path.resolve("dist-runtime", "extensions");
    fs.mkdirSync(bundledRoot, { recursive: true });
    const fixtureRoot = fs.mkdtempSync(path.join(bundledRoot, ".cold-facade-"));
    const pluginRoot = path.join(fixtureRoot, "fixture");
    fs.mkdirSync(pluginRoot);
    fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), '{"id":"cold-facade-owner"}\n');
    fs.writeFileSync(path.join(pluginRoot, "api.ts"), 'export const marker: string = "cold";\n');

    resetFacadeRuntimeStateForTest();
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", fixtureRoot);
    try {
      const params = { dirName: "fixture", artifactBasename: "api.js" };
      const loaded = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>(params);
      expect(loaded).toEqual({ marker: "cold" });
      expect(loadBundledPluginPublicSurfaceModuleSync(params)).toBe(loaded);
      expect(listImportedBundledPluginFacadeIds()).toEqual(["cold-facade-owner"]);
      expect(() => loadActivatedBundledPluginPublicSurfaceModuleSync(params)).toThrow(
        'Bundled plugin public surface access blocked for "cold-facade-owner"',
      );
    } finally {
      resetFacadeRuntimeStateForTest();
      vi.unstubAllEnvs();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
  it("uses the live source config snapshot during cold synchronous activation", async ({
    signal,
  }) => {
    const bundledRoot = path.resolve("dist-runtime", "extensions");
    fs.mkdirSync(bundledRoot, { recursive: true });
    const fixtureRoot = fixtureLifetime.createTempDir(".cold-native-facade-", bundledRoot);
    const isolatedRoot = fixtureLifetime.createTempDir("openclaw-cold-native-facade-");
    const pluginRoot = path.join(fixtureRoot, "fixture");
    fs.mkdirSync(pluginRoot);
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "@openclaw/cold-native-facade",
        version: "0.0.0",
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: "cold-native-owner",
        enabledByDefault: true,
        channels: [],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      'export default { id: "cold-native-owner", register() {} };\n',
    );
    fs.writeFileSync(path.join(pluginRoot, "api.ts"), 'export const marker: string = "cold";\n');
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
    const { setRuntimeConfigSnapshot } = await import(${JSON.stringify(
      pathToFileURL(path.resolve("src/config/runtime-snapshot.ts")).href,
    )});
    const { loadActivatedBundledPluginPublicSurfaceModuleSync: load, listImportedBundledPluginFacadeIds } = await import(${JSON.stringify(
      pathToFileURL(path.resolve("src/plugin-sdk/facade-runtime.ts")).href,
    )});
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
          imports: [pathToFileURL(path.resolve("scripts/tsx.mjs")).href],
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
      result.error,
      `Child inputs: ${fixtureRoot}; ${isolatedRoot}\n${result.stderr}`,
    ).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("cold facade follows the native source config snapshot");
  });
});
