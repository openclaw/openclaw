import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { capturePluginStateOperationModuleSource } from "./plugin-state-operation-source.js";
import { loadValidatedPublicSurfaceModule } from "./public-surface-loader.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const instances: PluginInstance[] = [];
const caches: ReturnType<typeof createPluginCache>[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0).toReversed()) {
    await instance.dispose();
  }
  for (const cache of caches.splice(0)) {
    await retirePluginCache(cache);
  }
});

function fixture(files: Record<string, string>) {
  const root = temp.make("plugin-state-operation-source-");
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function bind(rootDir: string, entry = "index.ts", origin: "config" | "bundled" = "config") {
  const instance = new PluginInstance("operation-fixture");
  instances.push(instance);
  const cache = createPluginCache();
  caches.push(cache);
  withPluginCache(cache, () =>
    bindPluginInstanceModuleLoader({
      instance,
      rootDir,
      source: path.join(rootDir, entry),
      origin,
    }),
  );
  return instance;
}

function readVersion(
  source: ReturnType<typeof capturePluginStateOperationModuleSource>,
  moduleName: string,
) {
  if (!source) {
    throw new Error("Expected captured operation source");
  }
  return loadValidatedPublicSurfaceModule({
    ...source.resolve(moduleName),
    capturedSource: true,
    surfaceLabel: "fixture state operation",
  });
}

describe("plugin state operation module ownership", () => {
  it("keeps the selected TypeScript generation and its relative dependencies after source edits", () => {
    const root = fixture({
      "package.json": '{"name":"operation-fixture","type":"module"}',
      "index.ts": "export const id = 'operation-fixture';",
      "state-operation-api.ts": "export { version } from './src/operation.js';",
      "state-operation-api.js": "export const version = 'stale built';",
      "src/operation.ts": "export const version = 'original source';",
    });
    const instance = bind(root);
    const source = capturePluginStateOperationModuleSource(instance, () => {});
    fs.writeFileSync(path.join(root, "src/operation.ts"), "export const version = 'changed';");
    fs.unlinkSync(path.join(root, "state-operation-api.ts"));

    expect(readVersion(source, "state-operation-api.js")).toMatchObject({
      version: "original source",
    });
  });

  it("keeps a dist entry in its build family and rejects paths and URLs", () => {
    const root = fixture({
      "package.json": '{"name":"operation-fixture","type":"module"}',
      "dist/index.js": "export const id = 'operation-fixture';",
      "dist/state-operation-api.js": "export const version = 'selected build';",
      "state-operation-api.ts": "export const version = 'wrong source';",
      "source-only-operation-api.ts": "export const version = 'source fallback';",
      "dist/private.js": "export const version = 'private';",
    });
    const source = capturePluginStateOperationModuleSource(bind(root, "dist/index.js"), () => {});
    const selected = "state-operation-api.js";
    expect(readVersion(source, selected)).toMatchObject({ version: "selected build" });
    expect(() => source!.resolve("source-only-operation-api.js")).toThrow(
      "absent from its captured source family",
    );
    for (const name of [
      "https://example.invalid/state-operation-api.js",
      pathToFileURL(path.join(root, "dist/state-operation-api.js")).href,
      path.join(root, "dist/state-operation-api.js"),
      "dist/state-operation-api.js",
      "../other/state-operation-api.js",
      "..\\other\\state-operation-api.js",
      "private.js",
      pathToFileURL(path.join(root, "../other/state-operation-api.js")).href,
      `${selected}?replacement=1`,
      `${selected}#replacement`,
    ]) {
      expect(() => source!.resolve(name)).toThrow("Plugin state operations require");
    }
  });

  it("rejects captured operations after owner or instance revocation", async () => {
    const root = fixture({
      "index.ts": "export const id = 'operation-fixture';",
      "state-operation-api.ts": "export const version = 1;",
    });
    const instance = bind(root);
    let current = true;
    const failure = new Error("operation owner revoked");
    const source = capturePluginStateOperationModuleSource(instance, () => {
      if (!current) {
        throw failure;
      }
    });
    const moduleName = "state-operation-api.js";
    source!.resolve(moduleName);
    current = false;
    expect(() => source!.resolve(moduleName)).toThrow(failure);
    current = true;
    await instance.dispose();
    expect(() => source!.resolve(moduleName)).toThrow("Plugin operation-fixture is retiring");
  });

  it("captures bundled operation closures without requiring bundled-away dependencies through recovery", async () => {
    const root = fixture({
      "package.json": JSON.stringify({
        name: "operation-fixture",
        dependencies: { "bundled-away": "1.0.0", "operation-dependency": "1.0.0" },
      }),
      "index.cjs": "module.exports = { id: 'operation-fixture' };",
      "state-operation-api.cjs": "module.exports = require('./src/operation.cjs');",
      "src/operation.cjs": "module.exports = { version: 'retained generation' };",
      "other-operation-api.cjs":
        "module.exports = { ...require('./src/operation.cjs'), dependency: require('operation-dependency').value };",
      "node_modules/operation-dependency/package.json": '{"main":"index.cjs"}',
      "node_modules/operation-dependency/index.cjs": "exports.value = 'captured dependency';",
      "source-only-operation-api.ts": "import 'missing-source-only-dependency';",
      "unrelated.cjs": "require('missing-unrelated-dependency');",
    });
    const original = bind(root, "index.cjs", "bundled");
    const recovery = original.captureModuleLoaderRecovery();
    await original.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    const restored = new PluginInstance("operation-fixture");
    instances.push(restored);
    recovery.bind(restored);
    const source = capturePluginStateOperationModuleSource(restored, () => {});

    expect(readVersion(source, "state-operation-api.cjs")).toMatchObject({
      version: "retained generation",
    });
    expect(readVersion(source, "other-operation-api.cjs")).toMatchObject({
      version: "retained generation",
      dependency: "captured dependency",
    });
    expect(() => source!.resolve("source-only-operation-api.js")).toThrow(
      "absent from its captured source family",
    );
  });

  it("refuses a bundled operation whose actual dependency is missing", () => {
    const root = fixture({
      "package.json": '{"name":"operation-fixture"}',
      "index.cjs": "module.exports = { id: 'operation-fixture' };",
      "state-operation-api.cjs": "module.exports = require('missing-operation-dependency');",
    });
    const instance = bind(root, "index.cjs", "bundled");
    const source = capturePluginStateOperationModuleSource(instance, () => {});

    expect(() => readVersion(source, "state-operation-api.cjs")).toThrow(
      "missing-operation-dependency",
    );
  });

  it("retains shared host chunks imported by compiled bundled operations", () => {
    const root = fixture({
      "package.json": '{"name":"openclaw","type":"module"}',
      "dist/extensions/operation-fixture/package.json": JSON.stringify({
        name: "operation-fixture",
        dependencies: { "bundled-away": "1.0.0" },
      }),
      "dist/extensions/operation-fixture/index.js": "export const id = 'operation-fixture';",
      "dist/extensions/operation-fixture/state-operation-api.js":
        "export { version } from '../../shared-operation.js';",
      "dist/shared-operation.js":
        "import { isRecord } from 'openclaw/plugin-sdk/string-coerce-runtime'; export const version = isRecord({}) ? 'captured host chunk' : 'invalid';",
      "dist/unrelated.js": "import 'missing-unrelated-dependency';",
    });
    const instance = bind(
      path.join(root, "dist/extensions/operation-fixture"),
      "index.js",
      "bundled",
    );
    const source = capturePluginStateOperationModuleSource(instance, () => {});
    fs.unlinkSync(path.join(root, "dist/shared-operation.js"));

    expect(readVersion(source, "state-operation-api.js")).toMatchObject({
      version: "captured host chunk",
    });
  });
});
