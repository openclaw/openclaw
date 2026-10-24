import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isPathInside } from "../infra/path-guards.js";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { useNodeModuleHooks } from "./native-module-require.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";

const { temp, fixture, host } = createPluginModuleGenerationTestHarness();
type Reader<T = number> = { read(): Promise<T> };
type Loader<T> = { load(): Promise<T> };
type Importer<T> = { read(name: string): Promise<T> };
type ModuleValue<T = number> = { value: T };

function write(root: string, file: string, source: string) {
  fs.writeFileSync(path.join(root, file), source);
}
const fileUrl = (root: string, file: string) => pathToFileURL(path.join(root, file)).href;
const valueModule = (value: number, name = "value") => `export const ${name} = ${value};`;
async function expectImportedValue<T>(promise: Promise<ModuleValue<T>>, value: T) {
  await expect(promise).resolves.toMatchObject({ value });
}
function expectRequiredIdentity(actual: { token: object }, expected: { token: object }) {
  if (process.versions.bun) {
    expect(actual).toEqual(expected);
    expect(actual.token).toBe(expected.token);
  } else {
    expect(actual).toBe(expected);
  }
}

describe("native plugin generation interop", () => {
  it.skipIf(!useNodeModuleHooks())(
    "preserves source import attributes for JSON resolved outside the capture",
    async () => {
      const root = fixture({
        "entry.ts":
          "export const read = async () => (await import('fixture:host-json')).default.answer;",
      });
      const json = path.join(temp.make("plugin-host-json-"), "answer.json");
      fs.writeFileSync(json, '{"answer":42}');
      const hooks = Module.registerHooks({
        resolve(specifier, context, nextResolve) {
          return specifier === "fixture:host-json"
            ? { url: pathToFileURL(json).href, shortCircuit: true }
            : nextResolve(specifier, context);
        },
      });
      try {
        const plugin = host(root).load("entry.ts") as Reader;
        await expect(plugin.read()).resolves.toBe(42);
      } finally {
        hooks.deregister();
      }
    },
  );

  it("preserves scoped sibling assets across generations", async () => {
    const root = fixture({
      "package.json": '{"dependencies":{"@fixture/asset-reader":"1.0.0"}}',
      "entry.cjs": "module.exports = require('@fixture/asset-reader');",
      "node_modules/@fixture/asset-reader/package.json":
        '{"name":"@fixture/asset-reader","main":"index.cjs","optionalDependencies":{"@fixture/platform":"1.0.0"}}',
      "node_modules/@fixture/asset-reader/index.cjs": `const fs = require('node:fs'); const path = require('node:path');
          exports.read = () => fs.readFileSync(path.join(__dirname, '../platform/vec0.so'), 'utf8');`,
      "node_modules/@fixture/platform/package.json": '{"name":"@fixture/platform"}',
      "node_modules/@fixture/platform/vec0.so": "before",
    });
    type Plugin = { read(): string };
    const firstHost = host(root);
    const first = firstHost.load("entry.cjs") as Plugin;
    write(root, "node_modules/@fixture/platform/vec0.so", "after");
    const second = host(root).load("entry.cjs") as Plugin;
    fs.rmSync(root, { recursive: true, force: true });
    expect(first.read()).toBe("before");
    expect(second.read()).toBe("after");
    await firstHost.dispose();
    expect(second.read()).toBe("after");
  });

  it("resolves an ancestor dependency alias matching a noninstalled plugin directory", () => {
    const root = fixture({
      "shared/package.json": '{"dependencies":{"shared":"npm:actual-shared@1.0.0"}}',
      "shared/entry.cjs": "module.exports = require('shared');",
      "node_modules/shared/package.json": '{"name":"actual-shared","main":"index.cjs"}',
      "node_modules/shared/index.cjs": "exports.value = 42;",
    });
    expect(host(path.join(root, "shared")).load("entry.cjs")).toMatchObject({ value: 42 });
  });

  it.each([true, false])(
    "preserves native-addon package-root detection (declared loader: %s)",
    (declared) => {
      const root = fixture({
        "package.json": '{"dependencies":{"native-addon":"1.0.0"}}',
        "entry.cjs": "module.exports = require('native-addon');",
        "node_modules/native-addon/package.json": JSON.stringify({
          name: "native-addon",
          main: "lib/database.cjs",
          dependencies: declared ? { "root-loader": "1.0.0" } : undefined,
        }),
        "node_modules/native-addon/lib/database.cjs": `
          const fs = require('node:fs');
          const path = require('node:path');
          const root = require('root-loader')(__filename);
          exports.relativeRoot = path.relative(__dirname, root);
          exports.read = () => fs.readFileSync(path.join(root, 'build/Release/addon.txt'), 'utf8');`,
        "node_modules/native-addon/build/Release/addon.txt": "before",
        "node_modules/root-loader/package.json": '{"main":"index.cjs"}',
        "node_modules/root-loader/index.cjs": `
          const fs = require('node:fs');
          const path = require('node:path');
          module.exports = file => {
            let directory = path.dirname(file);
            while (!fs.existsSync(path.join(directory, 'package.json')) &&
                   !fs.existsSync(path.join(directory, 'node_modules'))) {
              const parent = path.dirname(directory);
              if (parent === directory) throw new Error('Package root not found');
              directory = parent;
            }
            return directory;
          };`,
      });
      type Addon = { relativeRoot: string; read(): string };
      const captured = host(root).load("entry.cjs") as Addon;
      expect(captured.relativeRoot).toBe("..");
      write(root, "node_modules/native-addon/build/Release/addon.txt", "after");
      expect(captured.read()).toBe("before");
      expect((host(root).load("entry.cjs") as Addon).read()).toBe("after");
    },
  );

  it("reclaims only the retired generation's native and compiled Node cache records", async () => {
    const root = fixture({
      "entry.ts": `const native = require('./native.cjs');
        module.exports = { directory: module.path, captured: require.resolve('./native.cjs'),
          value: native.value, read: () => import('./async.ts') };`,
      "native.cjs": "exports.value = 7;",
      "async.ts": "export const value = 42;",
    });
    type Plugin = Record<"directory" | "captured", string> & ModuleValue & Reader<ModuleValue>;
    const cache = createRequire(import.meta.url).cache;
    const records = (plugin: Plugin) => {
      const directory = plugin.directory + path.sep;
      const namespace = pathToFileURL(directory).href;
      const captured = plugin.captured;
      return Object.entries(cache).filter(
        ([id]) =>
          id === captured ||
          (path.isAbsolute(id) && isPathInside(directory, id)) ||
          id.startsWith(namespace),
      );
    };
    const first = host(root);
    const plugin = first.load("entry.ts") as Plugin;
    expect(plugin.value).toBe(7);
    await expect(plugin.read()).resolves.toMatchObject({ value: 42 });
    const owned = records(plugin);
    expect(owned.length).toBeGreaterThan(0);
    const sibling = host(root).load("entry.ts") as Plugin;
    const preserved = records(sibling);
    await first.dispose();
    expect(owned.filter(([id]) => cache[id] !== undefined).map(([id]) => id)).toEqual([]);
    for (const [id, record] of preserved) {
      expect(cache[id], id).toBe(record);
    }
    expect(sibling.value).toBe(7);
  });

  it.each(["cts", "ts", "mts"])(
    "keeps async %s CommonJS imports reachable from synchronous registration",
    async (extension) => {
      const root = fixture({
        "index.ts": `export default { register(api) {
      api.read = async () => {
        const value = await import('./helper.${extension}');
        const read = value.read;
        return [value.value, value.default.value, read(), value.required];
      };
    } };`,
        [`helper.${extension}`]: `
      import { value } from 'conditional-dependency';
      await Promise.resolve();
      module.exports = { default: { value, read() { return this.value; } },
        required: require('conditional-dependency').value };
    `,
        "package.json": '{"dependencies":{"conditional-dependency":"1.0.0"}}',
        "node_modules/conditional-dependency/package.json":
          '{"exports":{"import":"./import.mjs","require":"./require.cjs"}}',
        "node_modules/conditional-dependency/import.mjs": valueModule(42),
        "node_modules/conditional-dependency/require.cjs": "exports.value = 7;",
      });
      type Plugin = { default: { register(api: { read?: () => Promise<unknown[]> }): void } };
      const plugin = host(root).load("index.ts") as Plugin;
      const api: { read?: () => Promise<unknown[]> } = {};
      plugin.default.register(api);
      await expect(api.read!()).resolves.toEqual([42, 42, 42, 7]);
    },
  );

  it("retains one async CommonJS evaluation failure per captured generation", async () => {
    const effect = path.join(temp.make("plugin-async-commonjs-effects-"), "effect.txt");
    const root = fixture({
      "index.ts": `const Map = {};
       export const read = () => import('./failure.cts');
       export const literal = "jitiImport(";
       export const strictThis = (function(this: void) { return this === undefined; })();`,
      "failure.cts": `
      await Promise.resolve();
      require('node:fs').appendFileSync(${JSON.stringify(effect)}, 'once\\n');
      module.exports = 42;
      throw new Error('async fixture failure');
    `,
    });
    const current = host(root).load("index.ts") as {
      literal: string;
      strictThis: boolean;
      read(): Promise<unknown>;
    };
    expect(current).toMatchObject({ literal: "jitiImport(", strictThis: true });
    const failure = await current.read().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty("message", "async fixture failure");
    await expect(current.read()).rejects.toBe(failure);
    expect(fs.readFileSync(effect, "utf8")).toBe("once\n");
  });

  it("preserves optional source resolver arguments during synchronous registration", () => {
    const root = fixture({
      "value.ts": valueModule(1),
      "nested/value.ts": valueModule(2),
      "package.json": '{"dependencies":{"conditional-dependency":"1.0.0"}}',
      "node_modules/conditional-dependency/package.json":
        '{"exports":{"custom":"./custom.mjs","import":"./import.mjs"}}',
      "node_modules/conditional-dependency/custom.mjs": valueModule(3),
      "node_modules/conditional-dependency/import.mjs": valueModule(4),
      "index.ts": `export default { register(api) {
      const resolve = import.meta.resolve;
      const parentURL = new URL('./nested/entry.ts', import.meta.url);
      api.results = [
        resolve('./value.ts', parentURL.href).endsWith('/nested/value.ts'),
        resolve('./value.ts', { parentURL }).endsWith('/nested/value.ts'),
        resolve('conditional-dependency', { conditions: ['custom'] }).endsWith('/custom.mjs'),
        resolve('missing-optional-dependency', { try: true }),
      ];
    } };`,
    });
    type Plugin = { default: { register(api: { results?: unknown[] }): void } };
    const plugin = host(root).load("index.ts") as Plugin;
    const api: { results?: unknown[] } = {};
    plugin.default.register(api);
    expect(api.results).toEqual([true, true, true, undefined]);
  });

  it("preserves resolver options in asynchronously imported ESM TypeScript", async () => {
    const root = fixture({
      "index.ts": "export const read = async () => (await import('./resolver.ts')).value;",
      "resolver.ts":
        "export const value = import.meta.resolve('missing-optional-dependency', { try: true }) ?? 42;",
    });
    await expect((host(root).load("index.ts") as Reader).read()).resolves.toBe(42);
  });

  it("links static ESM imports to an async CommonJS TypeScript child", async () => {
    const root = fixture({
      "entry.ts":
        "export const load = () => import('./parent.ts'); export const required = () => require('./parent.ts');",
      "parent.ts": `import value, { answer, read } from './child.cts';
        export const result = [value.value, answer, read()];
        export const cacheKey = Object.keys(require.cache).find(key => require.cache[key]?.filename === __filename);`,
      "child.cts": `await Promise.resolve();
        module.exports.default = { value: 42, read() { return this.value; } };
        module.exports[['ans', 'wer'].join('')] = 7;`,
    });
    const managed = host(root);
    const current = managed.load("entry.ts") as {
      load(): Promise<{ result: number[]; cacheKey: string }>;
      required(): { result: number[] };
    };
    const value = await current.load();
    expect(value.result).toEqual([42, 7, 42]);
    expect(current.required()).toMatchObject({ result: [42, 7, 42] });
    const cache = createRequire(import.meta.url).cache;
    const cacheKey = value.cacheKey;
    expect(cache[cacheKey]?.loaded).toBe(true);
    await managed.dispose();
    expect(cache[cacheKey]).toBeUndefined();
    expect(() => current.required()).toThrow("reloaded or disabled");
  });

  it("keeps async TypeScript cycle references live until module completion", async () => {
    const root = fixture({
      "entry.ts": "export const load = () => import('./first.ts');",
      "first.ts": `import { readSecond } from './second.ts';
        export const name = 'first';
        export const read = () => [name, readSecond()];`,
      "second.ts": `import * as first from './first.ts';
        export const readSecond = () => first.name;`,
    });
    const plugin = host(root).load("entry.ts") as Loader<{ read(): string[] }>;
    expect((await plugin.load()).read()).toEqual(["first", "first"]);
  });

  it.skipIf(!useNodeModuleHooks())(
    "waits for a concurrent lazy import to finish initializing its dependencies",
    async () => {
      const enteredEvent = "plugin-concurrent-import-entered";
      const releaseEvent = "plugin-concurrent-import-release";
      const root = fixture({
        "entry.ts": `const importModule = './parent.ts';
          export const read = async () => (await import(importModule)).read();`,
        "parent.ts":
          "import { answer } from './child.ts'; export function read() { return answer; }",
        "child.ts": `await new Promise(resolve => {
        process.once(${JSON.stringify(releaseEvent)}, resolve);
        process.emit(${JSON.stringify(enteredEvent)});
      }); export const answer = 42;`,
      });
      const entered = Promise.withResolvers<void>();
      process.once(enteredEvent, entered.resolve);
      const current = host(root).load("entry.ts") as Reader;
      const first = current.read();
      await entered.promise;
      const second = current.read();
      const results = Promise.all([first, second]);
      void results.catch(() => {});
      // Let the second import reach the in-flight module before completing its dependency.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      process.emit(releaseEvent);
      await expect(results).resolves.toEqual([42, 42]);
    },
  );

  it.each(["static", "dynamic"])(
    "preserves native TypeScript JSON import attributes (%s)",
    async (mode) => {
      const url = JSON.stringify(
        `data:application/json,${encodeURIComponent(JSON.stringify({ value: 42, mode }))}`,
      );
      const root = fixture({
        "package.json": '{"type":"module"}',
        "entry.mjs": 'export { read } from "./value.mts";',
        "value.mts":
          mode === "static"
            ? `import data from ${url} with { type: "json" }; export const read = async () => data.value;`
            : `export const read = async () => (await import(${url}, { with: { type: "json" } })).default.value;`,
      });
      const plugin = host(root, true).load("entry.mjs") as Reader;
      await expect(plugin.read()).resolves.toBe(42);
    },
  );

  it.each(["sync", "async", "native"])(
    "keeps %s TypeScript metadata and assets with captured source",
    async (mode) => {
      const root = fixture({
        "package.json": '{"type":"module"}',
        "entry.ts": 'export const load = () => import("./nested/source.ts");',
        "entry.mjs": 'export * from "./nested/source.ts";',
        "nested/asset.txt": "before",
        "nested/source.ts": `import fs from 'node:fs'; import path from 'node:path';
        declare const __filename: string; declare const __dirname: string;
        export const read = () => [
          fs.readFileSync(new URL('./asset.txt', import.meta.url), 'utf8'),
          fs.readFileSync(path.join(typeof __dirname === 'undefined' ? import.meta.dirname : __dirname, 'asset.txt'), 'utf8'),
          path.basename(import.meta.filename),
          path.basename(typeof __filename === 'undefined' ? import.meta.filename : __filename),
        ];`,
      });
      type Module = { read(): string[] };
      const expected = ["before", "before", "source.ts", "source.ts"];
      const managed = host(root);
      const plugin =
        mode === "async"
          ? await (managed.load("entry.ts") as Loader<Module>).load()
          : (managed.load(mode === "sync" ? "nested/source.ts" : "entry.mjs") as Module);
      write(root, "nested/asset.txt", "after");
      expect(plugin.read()).toEqual(expected);
    },
  );

  it.each([
    { standalone: false, extension: "ts", nativePeer: true },
    { standalone: true, extension: "cts", nativePeer: true },
    { standalone: true, extension: "ts", nativePeer: false },
    { standalone: true, extension: "cts", nativePeer: false },
  ])(
    "resolves $extension peers (native: $nativePeer, standalone: $standalone)",
    ({ extension, standalone, nativePeer }) => {
      const nativeExtension = extension === "cts" ? "cjs" : "js";
      const references = nativePeer
        ? [`./peer.${extension}`, `./peer.${nativeExtension}`]
        : [`./peer.${nativeExtension}`];
      const source = `exports.values = [${references.map((name) => `require(${JSON.stringify(name)}).value`).join(",")}];`;
      const root = fixture({
        "package.json": '{"type":"commonjs"}',
        [`peer.${extension}`]: 'exports.value = "typescript" as string;',
        ...(nativePeer ? { [`peer.${nativeExtension}`]: 'exports.value = "javascript";' } : {}),
        "entry.ts": source,
        "native.cjs": source,
      });
      const expected = { values: nativePeer ? ["typescript", "javascript"] : ["typescript"] };
      expect(host(root, standalone).load("entry.ts")).toMatchObject(expected);
      if (nativePeer) {
        expect(host(root).load("native.cjs")).toMatchObject(expected);
      }
    },
  );

  it.each(["ts", "cts"])(
    "keeps a compiled %s peer stable when its dependency package is promoted",
    async (extension) => {
      const nativeExtension = extension === "cts" ? "cjs" : "js";
      const root = fixture({
        "plugin/package.json": "{}",
        "plugin/entry.mjs": "export const read = name => import(name);",
        "node_modules/peer-dependency/package.json": JSON.stringify({
          name: "peer-dependency",
          type: "commonjs",
          exports: { "./native": `./peer.${nativeExtension}` },
        }),
        [`node_modules/peer-dependency/peer.${extension}`]:
          'exports.value = "typescript" as string;',
        [`node_modules/peer-dependency/peer.${nativeExtension}`]: 'exports.value = "javascript";',
      });
      const pluginRoot = path.join(root, "plugin");
      const typed = path.join(root, `node_modules/peer-dependency/peer.${extension}`);
      const plugin = host(pluginRoot, true).load("entry.mjs") as Importer<ModuleValue<string>>;
      await expectImportedValue(plugin.read(pathToFileURL(typed).href), "typescript");
      await expectImportedValue(plugin.read("peer-dependency/native"), "javascript");
      await expectImportedValue(plugin.read(pathToFileURL(typed).href), "typescript");
    },
  );

  it.each([
    { prefetchMetadata: false, reference: "absolute" },
    { prefetchMetadata: true, reference: "file URL" },
  ])(
    "promotes a selected dependency entry for a later bare export ($reference, metadata: $prefetchMetadata)",
    async ({ prefetchMetadata, reference }) => {
      const root = fixture({
        "plugin/package.json": JSON.stringify({
          imports: prefetchMetadata ? { "#optional": "source-dependency" } : undefined,
        }),
        "plugin/entry.mjs": "export const read = name => import(name);",
        "plugin/later.mjs": "export const value = 1;",
        "node_modules/source-dependency/package.json": JSON.stringify({
          name: "source-dependency",
          type: "module",
          exports: { ".": "./first.mjs", "./second": "./second.mjs" },
        }),
        "node_modules/source-dependency/first.mjs": valueModule(42),
        "node_modules/source-dependency/second.mjs": valueModule(84),
      });
      const pluginRoot = path.join(root, "plugin");
      const plugin = host(pluginRoot, true).load("entry.mjs") as Importer<ModuleValue>;
      const first = path.join(root, "node_modules/source-dependency/first.mjs");
      const specifier =
        reference === "absolute" ? toSafeImportPath(first) : pathToFileURL(first).href;
      await expectImportedValue(plugin.read(specifier), 42);
      fs.writeFileSync(first, valueModule(43));
      write(pluginRoot, "later.mjs", valueModule(2));
      await expectImportedValue(plugin.read("source-dependency/second"), 84);
      await expectImportedValue(plugin.read(`${pathToFileURL(first).href}?captured`), 42);
      await expectImportedValue(plugin.read("./later.mjs"), 2);
    },
  );

  it.each([
    { standalone: false, reference: "static", nestedManifest: false },
    { standalone: false, reference: "computed", nestedManifest: true },
    { standalone: true, reference: "static", nestedManifest: true },
    { standalone: true, reference: "computed", nestedManifest: false },
  ])(
    "resolves nested dependency versions from each importer ($reference, standalone: $standalone, nested manifest: $nestedManifest)",
    async ({ standalone, reference, nestedManifest }) => {
      const root = fixture({
        "package.json": JSON.stringify({
          type: "module",
          dependencies: { "versioned-dependency": "1.0.0" },
        }),
        "entry.mjs":
          'import { value as rootVersion } from "versioned-dependency"; export { rootVersion }; export { read as readNested } from "./nested/lib/consumer.mjs";',
        ...(nestedManifest
          ? {
              "nested/package.json": JSON.stringify({
                type: "module",
                dependencies: { "versioned-dependency": "2.0.0" },
              }),
            }
          : {}),
        "nested/lib/consumer.mjs":
          reference === "static"
            ? 'import { value } from "versioned-dependency"; export const read = async () => value;'
            : "export const read = async name => (await import(name)).value;",
        "node_modules/versioned-dependency/package.json":
          '{"name":"versioned-dependency","version":"1.0.0","type":"module","exports":{".":"./index.mjs","./sub:entry":"./index.mjs"}}',
        "node_modules/versioned-dependency/index.mjs": valueModule(1),
        "nested/node_modules/versioned-dependency/package.json":
          '{"name":"versioned-dependency","version":"2.0.0","type":"module","exports":{".":"./index.mjs","./sub:entry":"./index.mjs"}}',
        "nested/node_modules/versioned-dependency/index.mjs": valueModule(2),
      });
      type Plugin = { rootVersion: number; readNested(name: string): Promise<number> };
      const plugin = host(root, standalone).load("entry.mjs") as Plugin;
      expect(plugin.rootVersion).toBe(1);
      await expect(plugin.readNested("versioned-dependency/sub:entry")).resolves.toBe(2);
      await expect(plugin.readNested("versioned-dependency")).resolves.toBe(2);
    },
  );

  it.each(["module", "commonjs", undefined])(
    "preserves native side-effect TypeScript format in a %s package",
    (type) => {
      const root = fixture({
        "package.json": JSON.stringify({ type }),
        "entry.mjs": 'import "./effect.ts";',
      });
      const event = `native-ts-format-${path.basename(root)}`;
      fs.writeFileSync(
        path.join(root, "effect.ts"),
        `const value: string = typeof exports; process.emit(${JSON.stringify(event)}, value);`,
      );
      const values: string[] = [];
      const observe = (value: string) => values.push(value);
      process.on(event, observe);
      try {
        createRequire(import.meta.url)(path.join(root, "entry.mjs"));
        expect(values).toHaveLength(1);
        if (!process.versions.bun) {
          expect(values[0]).toBe(type === "module" ? "undefined" : "object");
        }
        host(root).load("entry.mjs");
        expect(values[1]).toBe(values[0]);
      } finally {
        process.off(event, observe);
      }
    },
  );

  it.each(
    [true, false].flatMap((standalone) =>
      ["directory", "file"].map((link) => ({ standalone, link })),
    ),
  )("loads shared module links ($link, standalone: $standalone)", ({ standalone, link }) => {
    const linkedPath = link === "directory" ? "shared/value.mjs" : "value.mjs";
    const root = fixture({
      "plugin/entry.mjs": `export { value } from "./${linkedPath}";`,
      "shared/value.mjs": valueModule(42),
    });
    const plugin = path.join(root, "plugin");
    fs.symlinkSync(
      path.join(root, link === "directory" ? "shared" : "shared/value.mjs"),
      path.join(plugin, link === "directory" ? "shared" : "value.mjs"),
      link === "directory" ? "junction" : "file",
    );
    expect(() => capturePluginGenerationArtifact(plugin)).toThrow(
      "Plugin source link leaves its package",
    );
    expect(host(plugin, standalone).load("entry.mjs")).toMatchObject({ value: 42 });
  });

  it.each([
    { extension: "mjs", reference: "relative" },
    { extension: "mjs", reference: "absolute" },
    { extension: "ts", reference: "file URL" },
  ])(
    "reloads standalone $extension entries with $reference shared modules",
    async ({ extension, reference }) => {
      const root = fixture({
        "package.json": JSON.stringify({ imports: { "#answer": `./shared/answer.${extension}` } }),
        [`plugin/entry.${extension}`]: "",
        [`plugin/local.${extension}`]: valueModule(17),
        [`shared/value.${extension}`]: 'export { answer } from "#answer";',
        [`shared/answer.${extension}`]: valueModule(42, "answer"),
      });
      const shared = path.join(root, "shared", `value.${extension}`);
      const specifier =
        reference === "relative"
          ? `../shared/value.${extension}`
          : reference === "absolute"
            ? toSafeImportPath(shared)
            : pathToFileURL(shared).href;
      write(
        root,
        `plugin/entry.${extension}`,
        `import { answer } from ${JSON.stringify(specifier)}; export const value = answer;
         export const readLocal = (specifier) => import(specifier).then(module => module.value);`,
      );
      const first = host(path.join(root, "plugin"), true).load(`entry.${extension}`) as {
        value: number;
        readLocal(specifier: string): Promise<number>;
      };
      expect(first).toMatchObject({ value: 42 });
      await expect(first.readLocal(fileUrl(root, `plugin/local.${extension}`))).resolves.toBe(17);
      fs.writeFileSync(shared, valueModule(43, "answer"));
      expect(host(path.join(root, "plugin"), true).load(`entry.${extension}`)).toMatchObject({
        value: 43,
      });
      expect(first).toMatchObject({ value: 42 });
    },
  );

  it.each(["relative", "file URL"])(
    "compiles declared TypeScript dependencies using %s imports",
    (reference) => {
      const root = fixture({
        "package.json": '{"dependencies":{"source-dependency":"1.0.0"}}',
        "entry.ts": 'export { answer } from "source-dependency";',
        "node_modules/source-dependency/package.json":
          '{"name":"source-dependency","type":"module","exports":"./index.ts"}',
        "node_modules/source-dependency/index.ts":
          'import { value } from "./value.js"; export const answer: number = value;',
        "node_modules/source-dependency/value.ts": "export const value: number = 42;",
      });
      if (reference === "file URL") {
        const target = fileUrl(root, "node_modules/source-dependency/value.ts");
        write(
          root,
          "node_modules/source-dependency/index.ts",
          `import { value } from ${JSON.stringify(target)}; export const answer: number = value;`,
        );
      }
      expect(host(root).load("entry.ts")).toMatchObject({ answer: 42 });
    },
  );

  it.each(["static", "dynamic"])(
    "keeps %s CommonJS imports separate from raw require values",
    async (firstImport) => {
      for (const [name, filename, source] of [
        ["plain", "dep.cjs", "exports.answer = 42;"],
        [
          "marker",
          "dep.cjs",
          'Object.defineProperty(exports, "__esModule", { value: true }); exports.answer = 42;',
        ],
        [
          "own-default",
          "nested/dep.js",
          'Object.defineProperty(exports, "__esModule", { value: true }); exports.default = { answer: 0 }; exports.answer = 42;',
        ],
      ] as const) {
        const root = fixture({
          "package.json": '{"type":"module"}',
          "nested/package.json": '{"type":"commonjs"}',
          [filename]: `${source}
            Object.defineProperty(exports, "hidden", { value: 17 });
            exports.getterReads = 0;
            Object.defineProperty(exports, "broken", { enumerable: true, get() {
              exports.getterReads++; throw new Error("unrelated getter");
            } });`,
          "entry.mjs": `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);
            import value, * as namespace from "./${filename}";
            import { answer, hidden } from "./${filename}";
            export { default as reexported } from "./${filename}";
            export { answer } from "./${filename}";
            export { value, namespace, hidden };
            export const readNamed = () => answer;
            export const required = require("./${filename}");
            export const readNamespace = () => namespace;
            export const lazy = () => import("./${filename}");`,
          "lazy.cjs": `exports.load = () => import("./${filename}");`,
        });
        const managed = host(root);
        type Value = { answer: number; getterReads: number; default?: unknown };
        type Namespace = { answer: number; default: Value };
        const first =
          firstImport === "dynamic"
            ? await (managed.load("lazy.cjs") as { load(): Promise<Namespace> }).load()
            : undefined;
        const entry = managed.load("entry.mjs") as Record<
          "value" | "required" | "reexported",
          Value
        > &
          Record<"answer" | "hidden", number> & {
            namespace: Namespace;
            readNamed(): number;
            readNamespace(): Namespace;
            lazy(): Promise<Namespace>;
          };
        const importedValue =
          process.versions.bun && name === "own-default"
            ? (entry.required.default as Value)
            : entry.required;
        expect(entry.hidden).toBe(17);
        expect(entry.value).toBe(importedValue);
        expect(entry.reexported).toBe(importedValue);
        expect(entry.namespace.default).toBe(importedValue);
        // Method results expose native namespaces; exported members are instance-bound views.
        const namespace = entry.readNamespace();
        expect(await entry.lazy()).toBe(namespace);
        if (first) {
          expect(first).toBe(namespace);
        }
        expect(entry.required.getterReads).toBe(process.versions.bun ? 1 : 0);
        entry.required.answer = 43;
        expect(entry.value.answer).toBe(importedValue === entry.required ? 43 : 0);
        expect([entry.readNamed(), entry.answer]).toEqual([42, 42]);
      }
    },
  );

  it("exposes named exports from native CommonJS TypeScript with transformed imports", () => {
    const root = fixture({
      "package.json": '{"type":"commonjs"}',
      "entry.mjs": 'export { value } from "./peer.ts";',
      "peer.ts":
        'import path from "node:path"; export const value = path.basename("/probe/answer");',
    });
    expect(host(root).load("entry.mjs")).toMatchObject({ value: "answer" });
  });

  it("preserves native TypeScript value scopes and erased declarations", () => {
    const root = fixture({
      "package.json": '{"type":"module"}',
      "entry.mjs": `export { value as enumeration } from "./enum.ts";
        export { value as namespace } from "./namespace.ts";
        export { value as merged } from "./merged.ts";
        export { value as erased } from "./erased.ts";`,
      "enum.ts": `enum __filename { Answer = 42 }
        enum Values { __dirname = 42, Answer = __dirname }
        export const value = [__filename.Answer, Values.Answer];`,
      "namespace.ts": `namespace __dirname { export const Answer = 42 }
        export const value = __dirname.Answer;`,
      "merged.ts": `namespace Values {
          export const __filename = 40;
          export namespace Nested { export const __dirname = 41 }
        }
        namespace Values {
          export const answer = __filename + 2;
          export namespace Nested { export const answer = __dirname + 1 }
        }
        export const value = [Values.answer, Values.Nested.answer];`,
      "erased.ts": `import type require = require("missing-type-only-package");
        interface __filename {}
        type __dirname = unknown;
        export const value = [
          require("node:path").basename(__filename),
          require("node:path").basename(import.meta.filename),
          typeof __dirname,
        ];`,
    });
    expect(host(root).load("entry.mjs")).toMatchObject({
      enumeration: [42, 42],
      namespace: 42,
      merged: [42, 42],
      erased: ["erased.ts", "erased.ts", "string"],
    });
  });

  it.each([
    ["explicit", "dep.mjs", "commonjs"],
    ["package", "dep.js", "module"],
    ["syntax", "dep.js", undefined],
    ["typescript", "dep.mts", "commonjs"],
    ["typescript-module-package", "dep.ts", "module"],
  ] as const)(
    "retains %s ESM default, named and reexport live bindings",
    async (_name, filename, type) => {
      const emptyFilename = type === "module" ? "empty.js" : "empty.mjs";
      const root = fixture({
        "package.json": JSON.stringify(type ? { type } : {}),
        [filename]:
          "let value = 1; export { value, value as default }; export const update = () => value++;",
        "entry.mjs": `import current, * as namespace from "./${filename}";
        export { default as current, value } from "./${filename}";
        export * from "./${filename}";
        export { namespace };
        export const read = () => current;
        export const readNamespace = () => namespace;
        export const lazy = () => import("./${filename}");`,
        [emptyFilename]: "",
        "empty.cjs": `exports.load = () => import("./${emptyFilename}");`,
      });
      const entry = host(root).load("entry.mjs") as {
        current: number;
        value: number;
        read(): number;
        readNamespace(): { default: number; value: number };
        update(): void;
        lazy(): Promise<unknown>;
      };
      const namespace = entry.readNamespace();
      expect(entry.read()).toBe(1);
      entry.update();
      expect(entry.read()).toBe(2);
      expect(entry).toMatchObject({ current: 2, value: 2 });
      expect(namespace.default).toBe(2);
      expect(await entry.lazy()).toBe(namespace);
      const empty = await (host(root).load("empty.cjs") as Loader<object>).load();
      expect(Object.hasOwn(empty, "default")).toBe(false);
    },
  );

  it("retains imported values when CommonJS removes its require cache entry", async () => {
    const root = fixture({
      "dep.cjs": "module.exports = { answer: 42 }; delete require.cache[__filename];",
      "entry.mjs": 'import value from "./dep.cjs"; export { value };',
      "promise.cjs": "module.exports = Promise.resolve({ answer: 42 });",
      "lazy.cjs": 'exports.load = () => import("./promise.cjs");',
    });
    const managed = host(root);
    expect(managed.load("entry.mjs")).toMatchObject({ value: { answer: 42 } });
    const lazy = managed.load("lazy.cjs") as Loader<{ default: Promise<unknown> }>;
    const namespace = await lazy.load();
    expect(namespace.default).toBeInstanceOf(Promise);
    await expect(namespace.default).resolves.toEqual({ answer: 42 });
  });

  it("preserves import and require package conditions in synchronous and lazy modules", async () => {
    const root = fixture({
      "package.json": JSON.stringify({ dependencies: { "conditional-dependency": "1.0.0" } }),
      "entry.ts": `import type { module, exports } from "missing-type-only-package";
        import { createRequire } from "node:module";
        import { value, token } from "conditional-dependency";
        export * as namespace from "conditional-dependency";
        export const imported = { value, token };
        export const required = require("conditional-dependency");
        export const createdRequire = createRequire(import.meta.url)("conditional-dependency");
        export const readImported = () => imported;
        export const readRequired = () => required;
        export const lazy = () => import("conditional-dependency");
        export const lazyModule = () => import("./lazy.ts");`,
      "lazy.ts": `import { value, token } from "conditional-dependency";
        export { value, token };
        export const required = require("conditional-dependency");`,
      "node_modules/conditional-dependency/package.json":
        '{"name":"conditional-dependency","type":"module","exports":{"import":"./import.js","require":"./require.cjs"}}',
      "node_modules/conditional-dependency/import.js":
        'export const value = "import"; export const token = {};',
      "node_modules/conditional-dependency/require.cjs":
        'module.exports = { value: "require", token: {} };',
    });
    type Dependency = { value: string; token: object };
    const entry = host(root).load("entry.ts") as Record<
      "imported" | "required" | "createdRequire" | "namespace",
      Dependency
    > & {
      readImported(): Dependency;
      readRequired(): Dependency;
      lazy: () => Promise<Dependency>;
      lazyModule: () => Promise<Dependency & { required: Dependency }>;
    };
    const imported = entry.readImported();
    const required = entry.readRequired();
    expect(entry.imported.value).toBe("require");
    expect(entry.namespace.token).toBe(entry.imported.token);
    expect(entry.required.value).toBe("require");
    expectRequiredIdentity(entry.createdRequire, entry.required);
    const lazy = await entry.lazy();
    expect(lazy.value).toBe("import");
    expect(lazy.token).not.toBe(imported.token);
    const lazyModule = await entry.lazyModule();
    expect(lazyModule.token).toBe(lazy.token);
    expectRequiredIdentity(lazyModule.required, required);
  });
});
