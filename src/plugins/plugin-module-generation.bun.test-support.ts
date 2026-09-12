import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { bindPluginInstanceModuleLoader } from "./plugin-module-loader-cache.js";

assert.ok(process.versions.bun, "this regression must execute in Bun");
const inputHome = process.argv[2];
assert.ok(inputHome, "the fixture requires its private home directory");
const home = inputHome;
const root = path.join(home, "plugin");
const roots = [root];
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
const instances: PluginInstance[] = [];
const cleanups = new Map<PluginInstance, number>();
let retained: ReturnType<PluginInstance["retainConsumer"]> | undefined;
type Shared = { value: string; count: number };
type Entry = { value: string; shared: Shared; read(): string };

function write(value: string) {
  fs.writeFileSync(
    path.join(root, "index.ts"),
    `import { shared } from './helper.ts';
     export { shared }; export const value: string = ${JSON.stringify(value)};
     export const read = () => shared.value;`,
  );
  fs.writeFileSync(
    path.join(root, "helper.ts"),
    `export const shared = { value: ${JSON.stringify(value)}, count: 0 };`,
  );
  fs.writeFileSync(path.join(root, "api.ts"), "export { shared } from './helper.ts';");
  fs.writeFileSync(path.join(root, "extra.ts"), `export const value = ${JSON.stringify(value)};`);
}

function createInstance(rootDir = root, standalone = false) {
  const instance = new PluginInstance("bun-generation-fixture");
  instances.push(instance);
  cleanups.set(instance, 0);
  instance.lifecycle.onDispose(() => {
    cleanups.set(instance, cleanups.get(instance)! + 1);
  });
  const source = path.join(rootDir, "index.ts");
  withPluginCache(createPluginCache(), () =>
    bindPluginInstanceModuleLoader({ instance, origin: "config", source, rootDir, standalone }),
  );
  return instance;
}

function load() {
  const instance = createInstance();
  const entry = instance.loadModule(path.join(root, "index.ts")) as Entry;
  const api = instance.loadModule(path.join(root, "api.ts")) as { shared: Shared };
  assert.equal(entry.shared, api.shared, "entry and public API must share their helper");
  return { instance, entry, api };
}

function fixture(name: string, files: Record<string, string>) {
  const directory = path.join(home, name);
  roots.push(directory);
  fs.mkdirSync(directory);
  for (const [file, contents] of Object.entries({
    "package.json": '{"type":"module"}',
    ...files,
  })) {
    const filename = path.join(directory, file);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  return directory;
}

try {
  write("before");
  fs.linkSync(path.join(root, "helper.ts"), path.join(root, "hardlinked.ts"));
  const first = load();
  assert.equal(first.entry.value, "before");
  assert.equal(first.entry.read(), "before");
  first.entry.shared.count = 7;
  fs.unlinkSync(path.join(root, "extra.ts"));
  assert.equal(first.instance.hasModuleSource(path.join(root, "extra.ts")), true);
  assert.equal(
    (first.instance.loadModule(path.join(root, "extra.ts")) as { value: string }).value,
    "before",
  );
  fs.writeFileSync(path.join(root, "new.ts"), "export const value = 'new';");
  assert.equal(first.instance.hasModuleSource(path.join(root, "new.ts")), false);
  assert.throws(() => first.instance.loadModule(path.join(root, "hardlinked.ts")), /hardlinked/);
  retained = first.instance.retainConsumer();

  // Reload prepares the replacement before retiring the existing instance.
  write("after");
  const second = load();
  assert.equal(second.entry.value, "after", "reload must evaluate the edited entry");
  assert.equal(second.entry.read(), "after", "reload must evaluate the edited helper");
  assert.notEqual(second.entry.shared, first.entry.shared);
  assert.equal(second.api.shared.count, 0);
  const disposal = first.instance.dispose();
  retained.run(() => {
    assert.equal(first.entry.value, "before");
    assert.equal(first.entry.read(), "before");
    assert.equal(first.api.shared.count, 7);
  });
  assert.equal(cleanups.get(first.instance), 0);
  retained.release();
  assert.deepEqual(await disposal, { errors: [] });
  assert.deepEqual(await first.instance.dispose(), { errors: [] });
  assert.equal(cleanups.get(first.instance), 1);
  assert.equal(second.entry.read(), "after", "old disposal must preserve the replacement");
  assert.deepEqual(await second.instance.dispose(), { errors: [] });

  const modes = ["async", "sync", "native"] as const;
  for (const firstMode of modes) {
    const directory = fixture(`maps-${firstMode}`, {
      "package.json": JSON.stringify({
        type: "module",
        imports: {
          "#choice": { bun: "./bun.cjs", require: "./require.cjs", import: "./import.mjs" },
        },
      }),
      "index.ts": `import { createRequire } from 'node:module';
        const native = createRequire(import.meta.url);
        export const read = {
          async: async (specifier: string) => (await import(specifier)).value,
          sync: (specifier: string) => require(specifier).value,
          native: (specifier: string) => native(specifier).value,
        };`,
      "bun.cjs": "exports.value = 'bun';",
      "require.cjs": "exports.value = 'require';",
      "import.mjs": "export const value = 'import';",
      "changed.cjs": "exports.value = 'changed';",
    });
    const instance = createInstance(directory, true);
    const entry = instance.loadModule(path.join(directory, "index.ts")) as {
      read: Record<(typeof modes)[number], (specifier: string) => string | Promise<string>>;
    };
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        type: "module",
        imports: { "#choice": "./changed.cjs" },
      }),
    );
    const results: Partial<Record<(typeof modes)[number], string>> = {};
    for (const mode of [firstMode, ...modes.filter((candidate) => candidate !== firstMode)]) {
      results[mode] = await entry.read[mode]("#choice");
    }
    assert.deepEqual(results, { async: "import", sync: "require", native: "bun" });
    assert.deepEqual(await instance.dispose(), { errors: [] });
  }

  const deferredDependencyRoot = fixture("deferred-native-dependency", {
    "package.json": JSON.stringify({
      type: "module",
      dependencies: { "deferred-dependency": "1" },
    }),
    "index.ts": "export const bridge = () => import('./bridge.mjs');",
    "bridge.mjs": `import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      export const read = async (name) => (await import(name)).value;
      export const readRequired = (name) => require(name).value;`,
    "node_modules/deferred-dependency/package.json": JSON.stringify({
      name: "deferred-dependency",
      type: "module",
      exports: { bun: "./bun.cjs", require: "./require.cjs", import: "./import.mjs" },
    }),
    "node_modules/deferred-dependency/bun.cjs": "exports.value = 42;",
    "node_modules/deferred-dependency/require.cjs": "exports.value = 0;",
    "node_modules/deferred-dependency/import.mjs": "export const value = 0;",
  });
  const deferredDependencyInstance = createInstance(deferredDependencyRoot, true);
  const deferredDependencyEntry = deferredDependencyInstance.loadModule(
    path.join(deferredDependencyRoot, "index.ts"),
  ) as {
    bridge(): Promise<{ read(name: string): Promise<number>; readRequired(name: string): number }>;
  };
  retained = deferredDependencyInstance.retainConsumer();
  const deferredDependencyRetirement = deferredDependencyInstance.dispose();
  await retained.run(async () => {
    const deferredDependency = await deferredDependencyEntry.bridge();
    assert.equal(await deferredDependency.read("deferred-dependency"), 42);
    assert.equal(deferredDependency.readRequired("deferred-dependency"), 42);
  });
  retained.release();
  assert.deepEqual(await deferredDependencyRetirement, { errors: [] });

  const dependency = fixture("linked-dependency", {
    "package.json": '{"name":"linked-dependency","type":"module","main":"./index.mjs"}',
    "index.mjs": "export const anchor = true;",
    "late-abs.mjs": "export const value = 41;",
    "late-url.mjs": "export const value = 42;",
  });
  const linkedRoot = fixture("dependency-link", {
    "package.json": JSON.stringify({
      type: "module",
      dependencies: { "linked-dependency": "1" },
      imports: { "#registered": "linked-dependency" },
    }),
    "index.ts": "export const bridge = () => import('./bridge.mjs');",
    "bridge.mjs":
      "export const url = import.meta.url; export const read = async (target) => (await import(target)).value;",
  });
  fs.mkdirSync(path.join(linkedRoot, "node_modules"));
  fs.symlinkSync(dependency, path.join(linkedRoot, "node_modules/linked-dependency"), "dir");
  const linkedInstance = createInstance(linkedRoot, true);
  const linkedEntry = linkedInstance.loadModule(path.join(linkedRoot, "index.ts")) as {
    bridge(): Promise<{ url: string; read(target: string): Promise<number> }>;
  };
  const bridge = await linkedEntry.bridge();
  const alias = path.join(
    path.dirname(fileURLToPath(bridge.url)),
    "node_modules/linked-dependency",
  );
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  for (const [filename, value] of [
    ["late-abs.mjs", 41],
    ["late-url.mjs", 42],
  ] as const) {
    const target = path.join(alias, filename);
    assert.equal(fs.existsSync(target), false, "metadata must not eagerly copy undeclared modules");
    assert.equal(await bridge.read(value === 41 ? target : pathToFileURL(target).href), value);
    fs.unlinkSync(path.join(dependency, filename));
    assert.equal(await bridge.read(target), value, "captured aliases survive original removal");
  }

  for (const standalone of [false, true]) {
    const directory = fixture(`absolute-${standalone}`, {
      "index.ts":
        "export const read = async (target: string) => (await import('./bridge.mjs')).read(target);",
      "bridge.mjs":
        "export const read = async (target) => { const loaded = await import(target); return { value: loaded.value, url: loaded.url }; };",
      "value.mjs": "export const value = 'before'; export const url = import.meta.url;",
    });
    const source = path.join(directory, "index.ts");
    const target = path.join(directory, "value.mjs");
    type NativeEntry = { read(target: string): Promise<{ value: string; url: string }> };
    const oldInstance = createInstance(directory, standalone);
    const oldEntry = oldInstance.loadModule(source) as NativeEntry;
    retained = oldInstance.retainConsumer();
    const retiring = oldInstance.dispose();
    fs.writeFileSync(target, "export const value = 'demand'; export const url = import.meta.url;");
    const old = await retained.run(() => oldEntry.read(target));
    assert.equal(old.value, standalone ? "demand" : "before");
    assert.notEqual(fileURLToPath(old.url), target);
    fs.writeFileSync(target, "export const value = 'after'; export const url = import.meta.url;");
    const currentInstance = createInstance(directory, standalone);
    const currentEntry = currentInstance.loadModule(source) as NativeEntry;
    const current = await currentEntry.read(pathToFileURL(target).href);
    assert.equal(current.value, "after");
    assert.notEqual(current.url, old.url);
    assert.deepEqual(await retained.run(() => oldEntry.read(pathToFileURL(target).href)), old);
    retained.release();
    assert.deepEqual(await retiring, { errors: [] });
    assert.deepEqual(await currentEntry.read(target), current);
  }

  const nativeRoot = fixture("native-retirement", {
    "package.json": JSON.stringify({
      type: "module",
      imports: {
        "#exact": {
          unused: "./unused/value.mjs",
          bun: "./targets/exact.mjs",
          default: "./other/exact.mjs",
        },
        "#wild/*": { bun: "./targets/*.mjs", default: "./other/*.mjs" },
        "#wild/blocked": null,
        "#wild/shadow": "./targets/exact.mjs",
        "#trailer/*.js": "./trailer/*.mjs",
        "#alias/*": "wildcard-alias/feature/*",
        "#missing": "./missing.mjs",
        "#invalid": "../outside.mjs",
      },
    }),
    "index.ts": `export const read = async (target: string = 'deep') => {
      const name: string = 'late';
      return (await import('./' + name + '.mjs')).read(target);
    };`,
    "late.mjs":
      "export const read = async (name) => (await import(name.startsWith('#') ? name : new URL('./' + name + '.mjs', import.meta.url))).value;",
    "deep.mjs": "export const value = 42;",
    "after-disposal.mjs": "export const value = 44;",
    "targets/exact.mjs": "export const value = 45;",
    "targets/leaf.mjs": "export const value = 46;",
    "targets/blocked.mjs": "export const value = 0;",
    "targets/shadow.mjs": "export const value = 0;",
    "trailer/leaf.mjs": "export const value = 47;",
    "node_modules/wildcard-alias/package.json": JSON.stringify({
      type: "module",
      exports: { "./feature/*": "./src/*.mjs" },
    }),
    "node_modules/wildcard-alias/src/leaf.mjs": "export const value = 48;",
    "other/exact.mjs": "export const value = 0;",
    "other/leaf.mjs": "export const value = 0;",
    "unused/package.json": "{invalid",
    "unused/value.mjs": "throw new Error('unselected source executed');",
    "unrelated.mjs": "throw new Error('unrelated source executed');",
    "targets/.git/ignored.mjs": "throw new Error('ignored source executed');",
    "targets/node_modules/ignored.mjs": "throw new Error('ignored source executed');",
  });
  fs.writeFileSync(path.join(home, "outside.mjs"), "export const value = 99;");
  roots.push(path.join(home, "outside.mjs"));
  const loadNative = () => {
    const instance = createInstance(nativeRoot, true);
    const entry = instance.loadModule(path.join(nativeRoot, "index.ts")) as {
      read(target?: string): Promise<number>;
    };
    return { instance, entry };
  };
  const oldNative = loadNative();
  for (const filename of [
    "unrelated.mjs",
    "targets/.git/ignored.mjs",
    "targets/node_modules/ignored.mjs",
  ]) {
    assert.equal(oldNative.instance.hasModuleSource(path.join(nativeRoot, filename)), false);
  }
  retained = oldNative.instance.retainConsumer();
  const retiring = oldNative.instance.dispose();
  assert.equal(await retained.run(() => oldNative.entry.read()), 42);
  assert.equal(await retained.run(() => oldNative.entry.read("#exact")), 45, "native condition");
  assert.equal(await retained.run(() => oldNative.entry.read("#wild/leaf")), 46);
  assert.equal(
    await retained.run(() => oldNative.entry.read("#wild/shadow")),
    45,
    "exact map entry",
  );
  assert.equal(await retained.run(() => oldNative.entry.read("#trailer/leaf.js")), 47);
  assert.equal(await retained.run(() => oldNative.entry.read("#alias/leaf")), 48);
  await assert.rejects(retained.run(() => oldNative.entry.read("#wild/blocked")));
  fs.writeFileSync(path.join(nativeRoot, "deep.mjs"), "export const value = 43;");
  const currentNative = loadNative();
  assert.equal(await currentNative.entry.read(), 43);
  assert.equal(await retained.run(() => oldNative.entry.read()), 42);
  retained.release();
  assert.deepEqual(await retiring, { errors: [] });
  assert.equal(await currentNative.entry.read(), 43);
  assert.equal(await currentNative.entry.read("after-disposal"), 44);
  await assert.rejects(currentNative.entry.read("#missing"));
  await assert.rejects(currentNative.entry.read("#invalid"));
} finally {
  retained?.release();
  for (const instance of instances.toReversed()) {
    await instance.dispose();
  }
  for (const directory of roots) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
for (const instance of instances) {
  assert.equal(cleanups.get(instance), 1, "each generation must clean up exactly once");
}
