/** Tests plugin module loader cache keys and lifecycle reset behavior. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createRequireRecord, importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import {
  createPluginCache,
  getPluginCache,
  resetPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import type { PluginModuleLoaderFactory } from "./plugin-module-loader-cache.js";

async function importPluginModuleLoader(scope: string) {
  return importFreshModule<typeof import("./plugin-module-loader-cache.js")>(
    import.meta.url,
    `./plugin-module-loader-cache.js?scope=${scope}`,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
  resetPluginCache();
});

function asPluginModuleLoaderFactory(factory: unknown): PluginModuleLoaderFactory {
  return factory as PluginModuleLoaderFactory;
}

async function mockLoader(
  scope: string,
  native?: typeof import("./native-module-require.js").tryNativeRequireJavaScriptModule,
  moduleExport?: unknown,
) {
  const fromSourceTransformer = vi.fn(() => moduleExport);
  const createJiti = vi.fn(
    (_filename: string, _options?: Record<string, unknown>) => fromSourceTransformer,
  );
  if (native) {
    vi.doMock("./native-module-require.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./native-module-require.js")>()),
      tryNativeRequireJavaScriptModule: native,
    }));
  }
  const owner = await importPluginModuleLoader(scope);
  const cache = createPluginCache();
  const load = (options: Partial<Parameters<typeof owner.getCachedPluginModuleLoader>[0]> = {}) =>
    withPluginCache(cache, () =>
      owner.getCachedPluginModuleLoader({
        modulePath: "/repo/dist/extensions/demo/api.js",
        importerUrl: fixtureFileUrl("src/plugins/public-surface-loader.ts"),
        loaderFilename: fixtureFileUrl("src/plugins/public-surface-loader.ts"),
        createLoader: asPluginModuleLoaderFactory(createJiti),
        ...options,
      }),
    );
  return { ...owner, load, createJiti, fromSourceTransformer };
}

function fixtureFileUrl(relativePath: string) {
  return pathToFileURL(path.resolve("/repo", relativePath)).href;
}

const requireRecord = createRequireRecord("object", "expected-label");

function expectSourceOptions(mock: { mock: { calls: unknown[][] } }, filename: string) {
  const [actualFilename, value] = mock.mock.calls[0] ?? [];
  expect(actualFilename).toBe(filename);
  const options = requireRecord(value, "jiti options");
  expect(options.tryNative).toBe(false);
  return options;
}

function expectStats(value: unknown, fields: Record<string, unknown>) {
  const stats = requireRecord(value, "loader stats");
  expect(stats).toMatchObject({
    calls: 1,
    nativeHits: 0,
    nativeMisses: 0,
    sourceTransformFallbacks: 0,
    sourceTransformForced: 0,
    ...fields,
  });
  return stats;
}

it.each(["cold", "legacy-cache"] as const)(
  "settles concurrent first imports before using dependency-backed exports (%s)",
  async (cacheState) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-concurrent-import-"));
    vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
    vi.stubEnv("JITI_FS_CACHE", "1");
    try {
      const entry = path.join(root, "entry.ts");
      const sources = [
        [
          entry,
          'export async function run() { const { read } = await import("./handler.ts"); return read(); }',
          false,
        ],
        [
          path.join(root, "handler.ts"),
          'import { readWorkspaceSkillsRequest } from "./helper.ts"; export function read() { return readWorkspaceSkillsRequest(); }',
          true,
        ],
        [
          path.join(root, "helper.ts"),
          'import path from "node:path"; export function readWorkspaceSkillsRequest() { return path.basename("/a/ready"); }',
          true,
        ],
      ] as const;
      for (const [filename, source] of sources) {
        fs.writeFileSync(filename, source);
      }
      if (cacheState === "legacy-cache") {
        const { createJiti } = await import("./jiti-factory.js");
        const { buildPluginLoaderJitiOptions } = await import("./sdk-alias.js");
        const legacy = createJiti(entry, {
          ...buildPluginLoaderJitiOptions({}, { modulePath: entry }),
          tryNative: false,
        });
        for (const [filename, source, asynchronous] of sources) {
          legacy.transform({ filename, source, ts: true, async: asynchronous });
        }
      }
      const { getCachedPluginModuleLoader } =
        await importPluginModuleLoader("concurrent-first-import");
      const load = withPluginCache(createPluginCache(), () =>
        getCachedPluginModuleLoader({
          modulePath: entry,
          importerUrl: import.meta.url,
          tryNative: false,
          aliasMap: {},
        }),
      );
      const loaded = load(entry) as { run(): Promise<string> };
      await expect(Promise.all([loaded.run(), loaded.run()])).resolves.toEqual(["ready", "ready"]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it("keeps source SDK evaluation native and preserves terminal failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-sdk-graph-"));
  try {
    const ownerPath = path.join(root, "loader.mjs");
    await build({
      stdin: {
        contents:
          'export { getCachedPluginModuleLoader } from "./src/plugins/plugin-module-loader-cache.ts";',
        resolveDir: process.cwd(),
      },
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      outfile: ownerPath,
      logLevel: "silent",
    });
    // Bundling the loader relocates its adjacent runtime schema asset.
    fs.copyFileSync(
      path.resolve("src/state/openclaw-state-schema.sql"),
      path.join(root, "openclaw-state-schema.sql"),
    );
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    const childOptions = {
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        JITI_FS_CACHE: "0",
      },
    };
    const result = spawnNodeEvalSync(
      `
          import assert from "node:assert/strict";
          import fs from "node:fs";
          import path from "node:path";
          import { pathToFileURL } from "node:url";
          import { getCachedPluginModuleLoader } from ${JSON.stringify(pathToFileURL(ownerPath).href)};
          const root = ${JSON.stringify(root)};
          const loadSdkFixture = (name, source, extension = "ts") => {
            const sdk = path.join(root, name + ".mts");
            const modulePath = path.join(root, name + "-entry." + extension);
            fs.mkdirSync(path.dirname(sdk), { recursive: true });
            fs.writeFileSync(sdk, source);
            fs.writeFileSync(modulePath, extension === "cjs"
              ? 'module.exports = require("openclaw/plugin-sdk/fixture");'
              : 'export * from "openclaw/plugin-sdk/fixture";\\n');
            const loader = getCachedPluginModuleLoader({
              modulePath, importerUrl: import.meta.url, tryNative: extension === "cjs",
              aliasMap: { "openclaw/plugin-sdk/fixture": sdk },
            });
            return () => loader(extension === "cjs" ? pathToFileURL(modulePath).href : modulePath);
          };
          assert.equal(loadSdkFixture("enum", "enum State { Ready }\\nexport const ready = State.Ready;")().ready, 0);
          assert.equal(loadSdkFixture("source-host/node_modules/sdk/index", "export const ready: number = 1;")().ready, 1);
          fs.writeFileSync(path.join(root, "url-peer.mts"), 'enum State { Ready } export const ready = State.Ready;');
          assert.equal(loadSdkFixture("url-sdk", 'export { ready } from "./url-peer.mjs";', "cjs")().ready, 0);
          const unrelated = path.join(root, "unrelated.ts");
          fs.writeFileSync(unrelated, 'export { value } from "./unrelated-peer.mjs";');
          fs.writeFileSync(path.join(root, "unrelated-peer.mts"), 'export const value = "unrelated";');
          assert.equal((await import(pathToFileURL(unrelated).href)).value, "unrelated");
          const broken = loadSdkFixture("broken", 'globalThis.sdkEvaluations = (globalThis.sdkEvaluations ?? 0) + 1; throw new Error("SDK evaluation failed");');
          assert.throws(broken, /SDK evaluation failed/);
          assert.equal(globalThis.sdkEvaluations, 1, "terminal native failures must not evaluate SDK source twice");
        `,
      {
        ...childOptions,
        imports: [pathToFileURL(path.resolve("scripts/tsx.mjs")).href],
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const withoutTypeStripping = spawnNodeEvalSync(
      `
          import assert from "node:assert/strict";
          import { getCachedPluginModuleLoader } from ${JSON.stringify(pathToFileURL(ownerPath).href)};
          const root = ${JSON.stringify(root)};
          const modulePath = root + "/enum-entry.ts";
          const load = getCachedPluginModuleLoader({
            modulePath, importerUrl: import.meta.url, tryNative: false,
            aliasMap: { "openclaw/plugin-sdk/fixture": root + "/enum.mts" },
          });
          assert.throws(() => load(modulePath), /Unable to load host Plugin SDK natively/);
        `,
      {
        ...childOptions,
        env: { ...childOptions.env, NODE_OPTIONS: "--no-strip-types" },
      },
    );
    expect(withoutTypeStripping.status, withoutTypeStripping.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps deferred module construction and evaluation in the creating cache generation", async () => {
  const { getCachedPluginModuleLoader } = await importPluginModuleLoader(
    "retained-loader-generation",
  );
  const owner = createPluginCache();
  const other = createPluginCache();
  const observedOwner: boolean[] = [];
  const createLoader = asPluginModuleLoaderFactory(() => {
    observedOwner.push(getPluginCache() === owner);
    return () => {
      observedOwner.push(getPluginCache() === owner);
      return { marker: "retained-generation" };
    };
  });
  const modulePath = "/repo/extensions/retained-generation/index.ts";
  const loader = withPluginCache(owner, () =>
    getCachedPluginModuleLoader({
      modulePath,
      importerUrl: import.meta.url,
      aliasMap: {},
      tryNative: false,
      createLoader,
    }),
  );

  const loaded = withPluginCache(other, () => {
    const value = loader(modulePath);
    expect(getPluginCache()).toBe(other);
    return value;
  });

  expect(loaded).toEqual({ marker: "retained-generation" });
  expect(observedOwner).toEqual([true, true]);
});

it("lets callers override alias maps and tryNative while keeping cache keys stable", async () => {
  const { createJiti, load } = await mockLoader("overrides");
  const first = load({
    tryNative: false,
    aliasMap: { alpha: "/repo/alpha.js", zeta: "/repo/zeta.js" },
  });
  const second = load({
    tryNative: false,
    aliasMap: { zeta: "/repo/zeta.js", alpha: "/repo/alpha.js" },
  });

  expect(second).toBe(first);
  first("/repo/extensions/demo/index.ts");
  expect(createJiti).toHaveBeenCalledTimes(1);
  const options = expectSourceOptions(
    createJiti,
    fixtureFileUrl("src/plugins/public-surface-loader.ts"),
  );
  expect(options.alias).toEqual({
    alpha: "/repo/alpha.js",
    zeta: "/repo/zeta.js",
  });
});

it.each([true, false])("reuses successful module exports (native: %s)", async (native) => {
  const moduleExport = { marker: native ? "native-cached" : "source-cached" };
  const nativeStub = vi.fn(() => ({ ok: true as const, moduleExport }));
  const { load, createJiti, fromSourceTransformer, getPluginModuleLoaderStats } = await mockLoader(
    `${native ? "native" : "source"}-export-cache`,
    nativeStub,
    moduleExport,
  );
  const modulePath = native ? "/repo/dist/extensions/demo/api.js" : "/repo/extensions/demo/api.ts";
  const loader = load(
    native
      ? {}
      : {
          modulePath,
          importerUrl: fixtureFileUrl("src/plugins/bundled-capability-runtime.ts"),
          loaderFilename: fixtureFileUrl("src/plugins/bundled-capability-runtime.ts"),
          tryNative: false,
        },
  );
  expect(loader(modulePath)).toBe(moduleExport);
  expect(loader(modulePath)).toBe(moduleExport);
  expect(nativeStub).toHaveBeenCalledTimes(native ? 1 : 0);
  expect(createJiti).toHaveBeenCalledTimes(native ? 0 : 1);
  const stats = expectStats(
    getPluginModuleLoaderStats(),
    native ? { nativeHits: 1 } : { sourceTransformForced: 1 },
  );
  if (!native) {
    expect(fromSourceTransformer).toHaveBeenCalledTimes(1);
    expect(stats.topSourceTransformTargets).toEqual([{ target: modulePath, count: 1 }]);
  }
});

it("propagates native plugin evaluation errors without running the plugin twice", async () => {
  vi.doUnmock("./native-module-require.js");
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-native-evaluation-"));
  const modulePath = path.join(fixtureDir, "plugin.cjs");
  const markerName = `openclaw.pluginModuleLoaderCache.nativeEvaluation:${fixtureDir}`;
  const sideEffectMarker = Symbol.for(markerName);
  const expectedError = "plugin exploded during native evaluation";

  try {
    fs.writeFileSync(
      modulePath,
      [
        `const marker = Symbol.for(${JSON.stringify(markerName)});`,
        "globalThis[marker] = (globalThis[marker] ?? 0) + 1;",
        `throw new Error(${JSON.stringify(expectedError)});`,
      ].join("\n"),
      "utf8",
    );
    const { load, createJiti } = await mockLoader("native-evaluation-error");
    const loader = load({
      modulePath,
      importerUrl: import.meta.url,
      loaderFilename: modulePath,
      tryNative: true,
    });

    expect(() => loader(modulePath)).toThrow(expectedError);
    expect(Reflect.get(globalThis, sideEffectMarker)).toBe(1);
    expect(createJiti).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(globalThis, sideEffectMarker);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

it.each([false, true])("falls back to source transform (Windows paths: %s)", async (windows) => {
  if (windows) {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  }
  const { load, createJiti, fromSourceTransformer, getPluginModuleLoaderStats } = await mockLoader(
    `native-require-fallback-${windows}`,
    () => ({ ok: false }),
    {
      fromSourceTransform: true,
    },
  );
  const modulePath = windows
    ? "C:\\Users\\alice\\openclaw\\dist\\extensions\\feishu\\api.js"
    : "/repo/dist/extensions/demo/api.js";
  const loaderFilename = windows
    ? modulePath
    : fixtureFileUrl("src/plugins/public-surface-loader.ts");
  const importerUrl = windows
    ? "file:///C:/Users/alice/openclaw/dist/src/plugins/public-surface-loader.js"
    : loaderFilename;
  const loader = load({
    modulePath,
    loaderFilename,
    importerUrl,
    ...(windows ? { tryNative: true } : {}),
  });
  expect(loader(modulePath)).toMatchObject({ fromSourceTransform: true });
  const expectedPath = windows
    ? "file:///C:/Users/alice/openclaw/dist/extensions/feishu/api.js"
    : process.platform === "win32"
      ? fixtureFileUrl("dist/extensions/demo/api.js")
      : modulePath;
  const options = expectSourceOptions(createJiti, windows ? expectedPath : loaderFilename);
  expect(options.nativeModules).toEqual(["openclaw"]);
  expect(fromSourceTransformer).toHaveBeenCalledWith(expectedPath);
  const stats = expectStats(getPluginModuleLoaderStats(), {
    nativeMisses: 1,
    sourceTransformFallbacks: 1,
  });
  expect(stats.topSourceTransformTargets).toEqual([{ target: modulePath, count: 1 }]);
});
