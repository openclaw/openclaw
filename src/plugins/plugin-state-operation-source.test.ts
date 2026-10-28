import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  bindPluginStateOperationModuleSource,
  capturePluginStateOperationModuleSource,
} from "./plugin-state-operation-source.js";
import { loadValidatedPublicSurfaceModule } from "./public-surface-loader.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const instances: PluginInstance[] = [];
const caches: ReturnType<typeof createPluginCache>[] = [];
const missing = "absent from its captured source family";
const operation = "state-operation-api.js";

afterEach(async () => {
  for (const instance of instances.splice(0).toReversed()) {
    await instance.dispose();
  }
  for (const cache of caches.splice(0)) {
    await retirePluginCache(cache);
  }
});

function fixture(files: Record<string, string>, entry = "index.ts", bundled = false, dir = "") {
  const root = temp.make("plugin-state-operation-source-");
  for (const [name, content] of Object.entries({ [path.join(dir, entry)]: "", ...files })) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const rootDir = path.join(root, dir);
  const instance = new PluginInstance("operation-fixture");
  instances.push(instance);
  const cache = createPluginCache();
  caches.push(cache);
  withPluginCache(cache, () =>
    bindPluginInstanceModuleLoader({
      instance,
      rootDir,
      source: path.join(rootDir, entry),
      origin: bundled ? "bundled" : "config",
    }),
  );
  return { root, instance, source: capture(instance) };
}

const capture = (instance: PluginInstance, assertCurrent = () => {}) =>
  capturePluginStateOperationModuleSource(instance, assertCurrent)!;

function load(source: ReturnType<typeof capture>, moduleName = operation) {
  return loadValidatedPublicSurfaceModule({
    ...source.resolve(moduleName),
    capturedSource: true,
    surfaceLabel: "fixture state operation",
  });
}

it("binds an image artifact that only exposes operation lookup", () => {
  const rootDir = temp.make("plugin-state-operation-image-");
  const modulePath = path.join(rootDir, operation);
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(modulePath, "export const version = 'image operation';");
  const instance = new PluginInstance("operation-fixture");
  instances.push(instance);
  bindPluginStateOperationModuleSource({
    instance,
    rootDir,
    source: path.join(rootDir, "index.js"),
    origin: "bundled",
    artifact: {
      rootDir,
      hasSource: (filename) => filename === modulePath,
      resolve: (filename) => filename,
      prepareModule: () => [],
    },
  });

  expect(load(capture(instance))).toMatchObject({ version: "image operation" });
  expect(() => capture(instance).resolve("missing-operation-api.js")).toThrow(missing);
});

it("retains TypeScript and relative dependencies after source edits", () => {
  const { root, source } = fixture({
    "package.json": '{"name":"operation-fixture","type":"module"}',
    "state-operation-api.ts": "export { version } from './src/operation.js';",
    "state-operation-api.js": "export const version = 'stale built';",
    "src/operation.ts": "export const version = 'original source';",
  });
  fs.writeFileSync(path.join(root, "src/operation.ts"), "export const version = 'changed';");
  fs.unlinkSync(path.join(root, "state-operation-api.ts"));

  expect(load(source)).toMatchObject({ version: "original source" });
});

it("keeps a dist entry in its build family and rejects paths and URLs", () => {
  const { root, source } = fixture(
    {
      "package.json": '{"name":"operation-fixture","type":"module"}',
      "dist/state-operation-api.js": "export const version = 'selected build';",
      "state-operation-api.ts": "export const version = 'wrong source';",
      "source-only-operation-api.ts": "export const version = 'source fallback';",
      "dist/private.js": "export const version = 'private';",
    },
    "dist/index.js",
  );
  expect(load(source)).toMatchObject({ version: "selected build" });
  expect(() => source.resolve("source-only-operation-api.js")).toThrow(missing);
  for (const name of [
    "https://example.invalid/state-operation-api.js",
    pathToFileURL(path.join(root, "dist/state-operation-api.js")).href,
    path.join(root, "dist/state-operation-api.js"),
    "dist/state-operation-api.js",
    "../other/state-operation-api.js",
    "..\\other\\state-operation-api.js",
    "private.js",
    pathToFileURL(path.join(root, "../other/state-operation-api.js")).href,
    `${operation}?replacement=1`,
    `${operation}#replacement`,
  ]) {
    expect(() => source.resolve(name)).toThrow("Plugin state operations require");
  }
});

it("rejects captured operations after owner or instance revocation", async () => {
  const { instance } = fixture({
    "state-operation-api.ts": "export const version = 1;",
  });
  let current = true;
  const failure = new Error("operation owner revoked");
  const source = capture(instance, () => {
    if (!current) {
      throw failure;
    }
  });
  source.resolve(operation);
  current = false;
  expect(() => source.resolve(operation)).toThrow(failure);
  current = true;
  await instance.dispose();
  expect(() => source.resolve(operation)).toThrow("Plugin operation-fixture is retiring");
});

it("recovers bundled closures without requiring bundled-away dependencies", async () => {
  const { root, instance: original } = fixture(
    {
      "package.json":
        '{"name":"operation-fixture","dependencies":{"bundled-away":"1.0.0","operation-dependency":"1.0.0"}}',
      "state-operation-api.cjs": "module.exports = require('./src/operation.cjs');",
      "src/operation.cjs": "module.exports = { version: 'retained generation' };",
      "other-operation-api.cjs":
        "module.exports = { ...require('./src/operation.cjs'), dependency: require('operation-dependency').value };",
      "node_modules/operation-dependency/package.json": '{"main":"index.cjs"}',
      "node_modules/operation-dependency/index.cjs": "exports.value = 'captured dependency';",
      "source-only-operation-api.ts": "import 'missing-source-only-dependency';",
      "unrelated.cjs": "require('missing-unrelated-dependency');",
    },
    "index.cjs",
    true,
  );
  const recovery = await original.captureModuleLoaderRecovery();
  await original.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  const restored = new PluginInstance("operation-fixture");
  instances.push(restored);
  recovery.bind(restored);
  const source = capture(restored);

  expect(load(source, "state-operation-api.cjs")).toMatchObject({ version: "retained generation" });
  expect(load(source, "other-operation-api.cjs")).toMatchObject({
    version: "retained generation",
    dependency: "captured dependency",
  });
  expect(() => source.resolve("source-only-operation-api.js")).toThrow(missing);
});

it("refuses a bundled operation whose actual dependency is missing", () => {
  const { source } = fixture(
    {
      "package.json": '{"name":"operation-fixture"}',
      "state-operation-api.cjs": "module.exports = require('missing-operation-dependency');",
    },
    "index.cjs",
    true,
  );

  expect(() => load(source, "state-operation-api.cjs")).toThrow("missing-operation-dependency");
});

it("retains shared host chunks imported by compiled bundled operations", () => {
  const { root, source } = fixture(
    {
      "package.json": '{"name":"openclaw","type":"module"}',
      "dist/extensions/operation-fixture/package.json":
        '{"name":"operation-fixture","dependencies":{"bundled-away":"1.0.0"}}',
      "dist/extensions/operation-fixture/state-operation-api.js":
        "export { version } from '../../shared-operation.js';",
      "dist/shared-operation.js":
        "import { isRecord } from 'openclaw/plugin-sdk/string-coerce-runtime'; export const version = isRecord({}) ? 'captured host chunk' : 'invalid';",
      "dist/unrelated.js": "import 'missing-unrelated-dependency';",
    },
    "index.js",
    true,
    "dist/extensions/operation-fixture",
  );
  fs.unlinkSync(path.join(root, "dist/shared-operation.js"));

  expect(load(source)).toMatchObject({ version: "captured host chunk" });
});
