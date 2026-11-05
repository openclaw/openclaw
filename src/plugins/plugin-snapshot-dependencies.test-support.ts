import assert from "node:assert/strict";
import fs from "node:fs";
import NativeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listDirectoryTreeStrictSync } from "../infra/directory-walk.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import {
  capturePluginSnapshotGeneration,
  capturePluginSourceSnapshot,
} from "./plugin-generation-capture.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { PluginSnapshotDependencyError } from "./plugin-snapshot-dependency-error.js";
import { pluginSnapshotModuleFacade } from "./plugin-snapshot-module-facade.js";

/** The late dependency did not exist when either generation captured its source. */
export async function runPluginSnapshotDependencyRegression(home: string) {
  const root = path.join(home, "plugin");
  const payload = path.join(home, "payload");
  const external = path.join(home, "late-external");
  const files = {
    "package.json": JSON.stringify({
      name: "snapshot-closure-fixture",
      dependencies: { "declared-dependency": "1" },
    }),
    "index.cjs": `const { createRequire } = require('node:module');
      exports.read = name => require(name).value;
      exports.resolve = name => require.resolve(name);
      exports.imported = async name => (await import(name)).value;
      exports.created = name => createRequire(__filename)(name).value;
      exports.reanchored = (anchor, name) => createRequire(anchor)(name).value;
      exports.computedRequired = (anchor, name) => require(['node', 'module'].join(':')).createRequire(anchor)(name).value;
      exports.bridge = () => import('./bridge.mjs');
      exports.asset = () => require('node:fs').readFileSync(require('node:path').join(__dirname, 'sibling.txt'), 'utf8');
      exports.filename = () => __filename;
      exports.moduleShape = () => { const Module = require('node:module'); return {
        callable: typeof Module, self: Module.Module === Module, keys: Object.keys(Module).sort(),
        cache: Module._cache === require.cache, constructed: typeof new Module('fixture'),
      }; };
      exports.builtin = () => require('node:path').basename('/fixture/value');`,
    "bridge.mjs": `import Module, { createRequire, builtinModules } from 'node:module';
      import fs from 'node:fs';
      const require = createRequire(import.meta.url);
      export const reanchored = (anchor, name) => createRequire(anchor)(name).value;
      export const defaultReanchored = (anchor, name) => Module.createRequire(anchor)(name).value;
      export const declared = () => require('declared-dependency').value;
      export const asset = () => fs.readFileSync(new URL('./sibling.txt', import.meta.url), 'utf8');
      export const filename = () => import.meta.filename;
      export const stableMeta = () => import.meta === import.meta;
      export const resolveModule = name => import.meta.resolve(name);
      export const moduleShape = () => ({callable: typeof Module, self: Module.Module === Module, named: Module.builtinModules === builtinModules});
      export const computedImported = async (anchor, name) => {
        const factory = await import(['node', 'module'].join(':'));
        return factory.createRequire(anchor)(name).value;
      };`,
    "sibling.txt": "captured sibling asset",
    "node_modules/declared-dependency/package.json":
      '{"name":"declared-dependency","main":"index.cjs"}',
    "node_modules/declared-dependency/index.cjs": "exports.value = 17;",
  };
  for (const [filename, contents] of Object.entries(files)) {
    const destination = path.join(root, filename);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  fs.cpSync(root, payload, { recursive: true });
  const snapshotSource = capturePluginSourceSnapshot(payload);
  const sourceDigest = snapshotSource.sourceDigest;
  snapshotSource.dispose();
  const sourcePaths = new Set([
    payload,
    ...listDirectoryTreeStrictSync(payload).map(({ relativePath }) =>
      path.join(payload, relativePath),
    ),
  ]);
  const instances: PluginInstance[] = [];
  const caches: ReturnType<typeof createPluginCache>[] = [];
  const retainedRequires: NodeJS.Require[] = [];
  type Entry = {
    read(name: string): number;
    resolve(name: string): string;
    imported(name: string): Promise<number>;
    created(name: string): number;
    reanchored(anchor: string, name: string): number;
    computedRequired(anchor: string, name: string): number;
    bridge(): Promise<{
      reanchored(anchor: string, name: string): number;
      defaultReanchored(anchor: string, name: string): number;
      computedImported(anchor: string, name: string): Promise<number>;
      declared(): number;
      asset(): string;
      filename(): string;
      stableMeta(): boolean;
      resolveModule(name: string): string;
      moduleShape(): { callable: string; self: boolean; named: boolean };
    }>;
    asset(): string;
    filename(): string;
    moduleShape(): {
      callable: string;
      self: boolean;
      keys: string[];
      cache: boolean;
      constructed: string;
    };
    builtin(): string;
  };
  const source = path.join(root, "index.cjs");
  const load = (frozen: boolean): Entry => {
    const instance = new PluginInstance("snapshot-closure-fixture");
    const cache = createPluginCache();
    instances.push(instance);
    caches.push(cache);
    const artifact = frozen
      ? capturePluginSnapshotGeneration(
          {
            rootDir: payload,
            sourceRoot: root,
            sourceAliases: { [root]: payload },
            sourcePaths,
            sourceLinks: new Map(),
            sourceHardlinks: new Set(),
            sourceDigest,
          },
          undefined,
          (run) => instance.run(run),
        )
      : undefined;
    withPluginCache(cache, () =>
      bindPluginInstanceModuleLoader({
        instance,
        origin: frozen ? "global" : "config",
        source,
        rootDir: root,
        preparedArtifact: artifact ? { artifact, attachModuleSource() {} } : undefined,
      }),
    );
    if (artifact) {
      const facade = pluginSnapshotModuleFacade(artifact, [], () => undefined)!;
      const module = NativeModule.createRequire(import.meta.url)(
        facade.filename,
      ) as typeof NativeModule;
      retainedRequires.push(module.createRequire(source));
    }
    return instance.loadModule(source) as Entry;
  };
  try {
    const mutable = load(false);
    const frozen = load(true);
    assert.equal(frozen.read("declared-dependency"), 17);
    assert.equal(frozen.created("declared-dependency"), 17);
    assert.equal(frozen.builtin(), "value");
    assert.deepEqual(frozen.moduleShape(), {
      callable: "function",
      self: true,
      keys: Object.keys(NativeModule).toSorted(),
      cache: true,
      constructed: "object",
    });
    assert.equal(frozen.asset(), "captured sibling asset");
    assert.equal(path.basename(frozen.filename()), "index.cjs");
    assert.equal(
      fs.readFileSync(path.join(path.dirname(frozen.filename()), "sibling.txt"), "utf8"),
      "captured sibling asset",
    );
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "package.json"), '{"name":"late-external"}');
    const target = path.join(external, "index.cjs");
    fs.writeFileSync(target, "exports.value = 42;");
    assert.equal(mutable.read(target), 42, "local source keeps dynamic capture behavior");
    const rejected = (error: unknown) => {
      assert.ok(error instanceof PluginSnapshotDependencyError);
      assert.equal(error.code, "ERR_PLUGIN_SNAPSHOT_DEPENDENCY");
      assert.equal(error.modulePath, target);
      assert.match(error.message, /Declare the dependency and reinstall or update/);
      assert.match(error.message, /local development source/);
      return true;
    };
    assert.throws(() => frozen.read(target), rejected);
    assert.throws(() => frozen.resolve(target), rejected);
    assert.throws(() => frozen.created(target), rejected);
    assert.throws(() => frozen.reanchored(path.join(external, "anchor.cjs"), target), rejected);
    const anchor = path.join(external, "anchor.cjs");
    assert.throws(() => frozen.computedRequired(anchor, target), rejected);
    const bridge = await frozen.bridge();
    assert.equal(bridge.declared(), 17);
    assert.equal(bridge.asset(), "captured sibling asset");
    assert.equal(path.basename(bridge.filename()), "bridge.mjs");
    assert.equal(bridge.stableMeta(), true);
    assert.deepEqual(bridge.moduleShape(), { callable: "function", self: true, named: true });
    assert.equal(
      fs.readFileSync(fileURLToPath(bridge.resolveModule("./sibling.txt")), "utf8"),
      "captured sibling asset",
    );
    assert.equal(await frozen.imported(bridge.resolveModule("declared-dependency")), 17);
    assert.throws(() => bridge.resolveModule(target), rejected);
    assert.throws(() => bridge.reanchored(anchor, target), rejected);
    assert.throws(() => bridge.defaultReanchored(anchor, target), rejected);
    await assert.rejects(bridge.computedImported(anchor, target), rejected);
    await assert.rejects(frozen.imported(pathToFileURL(target).href), rejected);
    await assert.rejects(frozen.imported("data:text/javascript,export const value=42"), {
      code: "ERR_PLUGIN_SNAPSHOT_DEPENDENCY",
    });
    const alias = path.join(payload, "node_modules/declared-dependency/late.cjs");
    fs.symlinkSync(target, alias);
    assert.throws(
      () => frozen.read(alias),
      (error: unknown) => {
        assert.ok(error instanceof PluginSnapshotDependencyError);
        assert.equal(error.code, "ERR_PLUGIN_SNAPSHOT_DEPENDENCY");
        return true;
      },
    );
    assert.equal(frozen.read("declared-dependency"), 17, "rejection preserves admitted modules");
  } finally {
    for (const instance of instances.toReversed()) {
      await instance.dispose();
    }
    for (const cache of caches) {
      await retirePluginCache(cache);
    }
  }
  for (const require of retainedRequires) {
    assert.throws(() => require("node:fs"), /Plugin source view has been disposed/);
    assert.throws(
      () => require.resolve("declared-dependency"),
      /Plugin source view has been disposed/,
    );
  }
}

if (process.argv[2] === "--snapshot-dependency-regression") {
  await runPluginSnapshotDependencyRegression(process.argv[3]!);
}
