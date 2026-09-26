import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";

const { temp, fixture, host } = createPluginModuleGenerationTestHarness();

describe("native plugin generation interop", () => {
  it("retains native require.resolve peers across dependency generations and disposal", async () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [`fixture-${index}`, "1.0.0"]),
    );
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ dependencies }),
      "entry.cjs": "module.exports = require('fixture-127');",
    };
    for (const name of Object.keys(dependencies)) {
      files[`node_modules/${name}/package.json`] = JSON.stringify({
        name,
        main: "index.cjs",
      });
      files[`node_modules/${name}/index.cjs`] = "exports.value = 'unused';";
    }
    files["node_modules/fixture-127/index.cjs"] = `
      exports.resolve = () => require.resolve('./peer.cjs');
      exports.read = () => require('./peer.cjs').value;`;
    const peer = "node_modules/fixture-127/peer.cjs";
    const before = "exports.value = 'before';";
    const after = "exports.value = 'after';";
    files[peer] = before;
    const root = fixture(files);
    type Plugin = { resolve(): string; read(): string };
    const firstHost = host(root);
    const first = firstHost.load("entry.cjs") as Plugin;
    const firstPath = first.resolve();
    expect(first.resolve()).toBe(firstPath);
    expect(firstPath).not.toBe(path.join(root, peer));
    expect(fs.readFileSync(firstPath, "utf8")).toBe(before);
    expect(first.read()).toBe("before");
    fs.writeFileSync(path.join(root, peer), after);
    const second = host(root).load("entry.cjs") as Plugin;
    const secondPath = second.resolve();
    expect(secondPath).not.toBe(firstPath);
    expect(fs.readFileSync(secondPath, "utf8")).toBe(after);
    expect(second.read()).toBe("after");
    expect(first.resolve()).toBe(firstPath);
    expect(fs.readFileSync(firstPath, "utf8")).toBe(before);
    expect(first.read()).toBe("before");
    await firstHost.dispose();
    expect(second.resolve()).toBe(secondPath);
    expect(fs.readFileSync(secondPath, "utf8")).toBe(after);
    expect(second.read()).toBe("after");
  });

  it.each(["", "@fixture/"])(
    "preserves %ssibling dependency assets across nested installs and generations",
    async (scope) => {
      const readerName = `${scope}asset-reader`;
      const platformName = `${scope}platform`;
      const installs = [
        ["", "1.0.0"],
        ["nested/", "2.0.0"],
      ] as const;
      const files: Record<string, string> = {
        "entry.cjs": `const root = require(${JSON.stringify(readerName)});
          const nested = require('./nested/entry.cjs');
          exports.read = () => [root.read(), nested.read()];`,
        "nested/entry.cjs": `module.exports = require(${JSON.stringify(readerName)});`,
      };
      for (const [prefix, version] of installs) {
        files[`${prefix}package.json`] = JSON.stringify({
          dependencies: { [readerName]: version },
        });
        files[`${prefix}node_modules/${readerName}/package.json`] = JSON.stringify({
          name: readerName,
          version,
          main: "index.cjs",
          optionalDependencies: { [platformName]: version },
        });
        files[`${prefix}node_modules/${readerName}/index.cjs`] = `
          const fs = require('node:fs');
          const path = require('node:path');
          exports.read = () => fs.readFileSync(path.join(__dirname, '../platform/vec0.so'), 'utf8');`;
        files[`${prefix}node_modules/${platformName}/package.json`] = JSON.stringify({
          name: platformName,
          version,
        });
        files[`${prefix}node_modules/${platformName}/vec0.so`] = `before-${version}`;
      }
      const root = fixture(files);
      type Plugin = { read(): string[] };
      const entry = path.join(root, "entry.cjs");
      const before = ["before-1.0.0", "before-2.0.0"];
      expect((createRequire(entry)(entry) as Plugin).read()).toEqual(before);
      const firstHost = host(root);
      const first = firstHost.load("entry.cjs") as Plugin;
      expect(first.read()).toEqual(before);
      for (const [prefix, version] of installs) {
        fs.writeFileSync(
          path.join(root, `${prefix}node_modules/${platformName}/vec0.so`),
          `after-${version}`,
        );
      }
      const second = host(root).load("entry.cjs") as Plugin;
      const after = ["after-1.0.0", "after-2.0.0"];
      expect(second.read()).toEqual(after);
      fs.rmSync(root, { recursive: true, force: true });
      expect(first.read()).toEqual(before);
      expect(second.read()).toEqual(after);
      await firstHost.dispose();
      expect(second.read()).toEqual(after);
    },
  );

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
      const entry = path.join(root, "entry.cjs");
      const original = createRequire(entry)(entry) as Addon;
      expect(original.relativeRoot).toBe("..");
      expect(original.read()).toBe("before");
      const captured = host(root).load("entry.cjs") as Addon;
      expect(captured.relativeRoot).toBe(original.relativeRoot);
      fs.writeFileSync(
        path.join(root, "node_modules/native-addon/build/Release/addon.txt"),
        "after",
      );
      expect(captured.read()).toBe("before");
      expect((host(root).load("entry.cjs") as Addon).read()).toBe("after");
    },
  );

  it.each(["ts", "cjs"])(
    "reclaims only the retired %s generation's Node cache records",
    async (extension) => {
      const root = fixture({
        [`entry.${extension}`]: `const native = require('./native.cjs');
        module.exports = { directory: module.path, captured: require.resolve('./native.cjs'),
          value: native.value, read: () => import('./async.ts') };`,
        "native.cjs": "exports.value = 7;",
        "async.ts": "export const value = 42;",
      });
      type Plugin = {
        directory: string;
        captured: string;
        value: number;
        read(): Promise<{ value: number }>;
      };
      const cache = createRequire(import.meta.url).cache;
      const records = (plugin: Plugin) => {
        const directory = plugin.directory + path.sep;
        const namespace = pathToFileURL(directory).href;
        const captured = plugin.captured;
        return Object.entries(cache).filter(
          ([id]) => id === captured || id.startsWith(directory) || id.startsWith(namespace),
        );
      };
      const first = host(root);
      const plugin = first.load(`entry.${extension}`) as Plugin;
      expect(plugin.value).toBe(7);
      if (extension === "ts") {
        await expect(plugin.read()).resolves.toMatchObject({ value: 42 });
      }
      const owned = records(plugin);
      expect(owned.length).toBeGreaterThan(0);
      expect(owned.some(([id]) => id === plugin.captured)).toBe(true);
      if (extension === "ts" && !process.versions.bun) {
        expect(owned.some(([id]) => !id.startsWith("file:") && id.endsWith(".mjs"))).toBe(true);
        expect(owned.some(([id]) => !id.startsWith("file:") && id.endsWith(".js"))).toBe(true);
        expect(owned.some(([id]) => id.startsWith("file:"))).toBe(true);
      }
      const sibling = host(root).load(`entry.${extension}`) as Plugin;
      const preserved = records(sibling);
      await first.dispose();
      expect(owned.filter(([id]) => cache[id] !== undefined).map(([id]) => id)).toEqual([]);
      for (const [id, record] of preserved) {
        expect(cache[id], id).toBe(record);
      }
      expect(sibling.value).toBe(7);
      expect((host(root).load(`entry.${extension}`) as Plugin).value).toBe(7);
    },
  );

  it.each(["cts", "ts", "mts"])(
    "keeps async %s CommonJS imports reachable from synchronous registration",
    async (extension) => {
      const root = temp.make("plugin-async-commonjs-");
      const source = path.join(root, "index.ts");
      fs.writeFileSync(
        source,
        `export default { register(api) {
      api.read = async () => {
        const value = await import('./helper.${extension}');
        const read = value.read;
        return [value.value, value.default.value, read(), value.required];
      };
    } };`,
      );
      fs.writeFileSync(
        path.join(root, `helper.${extension}`),
        `
      import { value } from 'conditional-dependency';
      await Promise.resolve();
      module.exports = { default: { value, read() { return this.value; } },
        required: require('conditional-dependency').value };
    `,
      );
      const dependency = path.join(root, "node_modules/conditional-dependency");
      fs.mkdirSync(dependency, { recursive: true });
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "conditional-dependency": "1.0.0" } }),
      );
      fs.writeFileSync(
        path.join(dependency, "package.json"),
        JSON.stringify({ exports: { import: "./import.mjs", require: "./require.cjs" } }),
      );
      fs.writeFileSync(path.join(dependency, "import.mjs"), "export const value = 42;");
      fs.writeFileSync(path.join(dependency, "require.cjs"), "exports.value = 7;");
      type Plugin = { default: { register(api: { read?: () => Promise<unknown[]> }): void } };
      const legacy = createJiti(source, { tryNative: false, fsCache: false, moduleCache: false })(
        source,
      ) as Plugin;
      const prior: { read?: () => Promise<unknown[]> } = {};
      expect(legacy.default.register(prior)).toBeUndefined();
      await expect(prior.read!()).resolves.toEqual([42, 42, 42, 7]);
      const current = host(root).load("index.ts") as Plugin;
      const selected: { read?: () => Promise<unknown[]> } = {};
      expect(current.default.register(selected)).toBeUndefined();
      await expect(selected.read!()).resolves.toEqual([42, 42, 42, 7]);
    },
  );

  it("retains one async CommonJS evaluation failure per captured generation", async () => {
    const root = temp.make("plugin-async-commonjs-failure-");
    const effect = path.join(temp.make("plugin-async-commonjs-effects-"), "effect.txt");
    fs.writeFileSync(
      path.join(root, "index.ts"),
      `const Map = {};
       export const read = () => import('./failure.cts');
       export const literal = "jitiImport(";
       export const strictThis = (function(this: void) { return this === undefined; })();`,
    );
    fs.writeFileSync(
      path.join(root, "failure.cts"),
      `
      await Promise.resolve();
      require('node:fs').appendFileSync(${JSON.stringify(effect)}, 'once\\n');
      module.exports = 42;
      throw new Error('async fixture failure');
    `,
    );
    const current = host(root).load("index.ts") as {
      literal: string;
      strictThis: boolean;
      read(): Promise<unknown>;
    };
    expect(current.literal).toBe("jitiImport(");
    expect(current.strictThis).toBe(true);
    const failure = await current.read().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty("message", "async fixture failure");
    await expect(current.read()).rejects.toBe(failure);
    expect(fs.readFileSync(effect, "utf8")).toBe("once\n");
  });

  it("preserves optional source resolver arguments during synchronous registration", () => {
    const root = temp.make("plugin-source-resolver-options-");
    const source = path.join(root, "index.ts");
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "value.ts"), "export const value = 1;");
    fs.writeFileSync(path.join(root, "nested/value.ts"), "export const value = 2;");
    const dependency = path.join(root, "node_modules/conditional-dependency");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "conditional-dependency": "1.0.0" } }),
    );
    fs.writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({ exports: { custom: "./custom.mjs", import: "./import.mjs" } }),
    );
    fs.writeFileSync(path.join(dependency, "custom.mjs"), "export const value = 3;");
    fs.writeFileSync(path.join(dependency, "import.mjs"), "export const value = 4;");
    fs.writeFileSync(
      source,
      `export default { register(api) {
      const resolve = import.meta.resolve;
      const parentURL = new URL('./nested/entry.ts', import.meta.url);
      api.results = [
        resolve('./value.ts', parentURL.href).endsWith('/nested/value.ts'),
        resolve('./value.ts', { parentURL }).endsWith('/nested/value.ts'),
        resolve('conditional-dependency', { conditions: ['custom'] }).endsWith('/custom.mjs'),
        resolve('missing-optional-dependency', { try: true }),
      ];
    } };`,
    );
    type Plugin = { default: { register(api: { results?: unknown[] }): void } };
    const legacy = createJiti(source, { tryNative: false, fsCache: false, moduleCache: false })(
      source,
    ) as Plugin;
    const prior: { results?: unknown[] } = {};
    legacy.default.register(prior);
    expect(prior.results).toEqual([true, true, true, undefined]);
    const current = host(root).load("index.ts") as Plugin;
    const selected: { results?: unknown[] } = {};
    current.default.register(selected);
    expect(selected.results).toEqual([true, true, true, undefined]);
  });

  it("preserves resolver options in asynchronously imported ESM TypeScript", async () => {
    const root = temp.make("plugin-async-esm-resolver-");
    const source = path.join(root, "index.ts");
    fs.writeFileSync(
      source,
      "export const read = async () => (await import('./resolver.ts')).value;",
    );
    fs.writeFileSync(
      path.join(root, "resolver.ts"),
      "export const value = import.meta.resolve('missing-optional-dependency', { try: true }) ?? 42;",
    );
    const legacy = createJiti(source, { tryNative: false, fsCache: false, moduleCache: false })(
      source,
    ) as { read(): Promise<number> };
    await expect(legacy.read()).resolves.toBe(42);
    const current = host(root).load("index.ts") as typeof legacy;
    await expect(current.read()).resolves.toBe(42);
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
    const entry = path.join(root, "entry.ts");
    const legacy = createJiti(entry, { tryNative: false, fsCache: false, moduleCache: false })(
      entry,
    ) as { load(): Promise<{ result: number[] }>; required(): { result: number[] } };
    await expect(legacy.load()).resolves.toMatchObject({ result: [42, 7, 42] });
    expect(legacy.required()).toMatchObject({ result: [42, 7, 42] });
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
    const entry = path.join(root, "entry.ts");
    const legacy = createJiti(entry, { tryNative: false, fsCache: false, moduleCache: false })(
      entry,
    ) as { load(): Promise<{ read(): string[] }> };
    expect((await legacy.load()).read()).toEqual(["first", "first"]);
    const current = host(root).load("entry.ts") as typeof legacy;
    expect((await current.load()).read()).toEqual(["first", "first"]);
  });

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
      const plugin = host(root, true).load("entry.mjs") as { read(): Promise<number> };
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
      const source = path.join(root, "nested/source.ts");
      const baseline = createJiti(source, { fsCache: false, moduleCache: false, tryNative: false })(
        source,
      ) as Module;
      const expected = ["before", "before", "source.ts", "source.ts"];
      expect(baseline.read()).toEqual(expected);
      expect((createRequire(import.meta.url)(source) as Module).read()).toEqual(expected);
      const managed = host(root);
      const plugin =
        mode === "async"
          ? await (managed.load("entry.ts") as { load(): Promise<Module> }).load()
          : (managed.load(mode === "sync" ? "nested/source.ts" : "entry.mjs") as Module);
      fs.writeFileSync(path.join(root, "nested/asset.txt"), "after");
      expect(plugin.read()).toEqual(expected);
    },
  );

  it.each(
    [false, true].flatMap((standalone) =>
      ["ts", "cts"].map((extension) => ({ standalone, extension })),
    ),
  )(
    "keeps explicit TS and JS peers distinct ($extension, standalone: $standalone)",
    ({ extension, standalone }) => {
      const nativeExtension = extension === "cts" ? "cjs" : "js";
      const references = [`./peer.${extension}`, `./peer.${nativeExtension}`];
      const root = fixture({
        "package.json": '{"type":"commonjs"}',
        [`peer.${extension}`]: 'exports.value = "typescript" as string;',
        [`peer.${nativeExtension}`]: 'exports.value = "javascript";',
        "entry.ts": `exports.values = [${references.map((name) => `require(${JSON.stringify(name)}).value`).join(",")}];`,
        "native.cjs": `exports.values = [${references.map((name) => `require(${JSON.stringify(name)}).value`).join(",")}];`,
      });
      const legacy = createJiti(path.join(root, "entry.ts"), {
        fsCache: false,
        moduleCache: false,
        tryNative: false,
      });
      expect(legacy(path.join(root, "entry.ts"))).toMatchObject({
        values: ["typescript", "javascript"],
      });
      expect(createRequire(import.meta.url)(path.join(root, "native.cjs"))).toMatchObject({
        values: ["typescript", "javascript"],
      });
      const managed = host(root, standalone);
      expect(managed.load("entry.ts")).toMatchObject({ values: ["typescript", "javascript"] });
      expect(host(root).load("native.cjs")).toMatchObject({ values: ["typescript", "javascript"] });
    },
  );

  it.each(["ts", "cts"])("resolves a missing JavaScript peer to its %s source", (extension) => {
    const nativeExtension = extension === "cts" ? "cjs" : "js";
    const root = fixture({
      "package.json": '{"type":"commonjs"}',
      "entry.ts": `exports.value = require('./peer.${nativeExtension}').value;`,
      [`peer.${extension}`]: 'exports.value = "typescript" as string;',
    });
    const legacy = createJiti(path.join(root, "entry.ts"), {
      fsCache: false,
      moduleCache: false,
      tryNative: false,
    });
    expect(legacy(path.join(root, "entry.ts"))).toMatchObject({ value: "typescript" });
    expect(host(root, true).load("entry.ts")).toMatchObject({ value: "typescript" });
  });

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
      const legacy = createJiti(path.join(pluginRoot, "entry.mjs"), {
        fsCache: false,
        moduleCache: false,
        tryNative: false,
      });
      expect(legacy(typed)).toMatchObject({ value: "typescript" });
      expect(
        createRequire(path.join(pluginRoot, "entry.mjs"))("peer-dependency/native"),
      ).toMatchObject({ value: "javascript" });
      const plugin = host(pluginRoot, true).load("entry.mjs") as {
        read(name: string): Promise<{ value: string }>;
      };
      await expect(plugin.read(pathToFileURL(typed).href)).resolves.toMatchObject({
        value: "typescript",
      });
      await expect(plugin.read("peer-dependency/native")).resolves.toMatchObject({
        value: "javascript",
      });
      await expect(plugin.read(pathToFileURL(typed).href)).resolves.toMatchObject({
        value: "typescript",
      });
    },
  );

  it.each(
    [false, true].flatMap((prefetchMetadata) =>
      ["absolute", "file URL"].map((reference) => ({ prefetchMetadata, reference })),
    ),
  )(
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
        "node_modules/source-dependency/first.mjs": "export const value = 42;",
        "node_modules/source-dependency/second.mjs": "export const value = 84;",
      });
      const pluginRoot = path.join(root, "plugin");
      const native = createRequire(path.join(pluginRoot, "entry.mjs"));
      expect(native("source-dependency/second")).toMatchObject({ value: 84 });
      const plugin = host(pluginRoot, true).load("entry.mjs") as {
        read(name: string): Promise<{ value: number }>;
      };
      const first = path.join(root, "node_modules/source-dependency/first.mjs");
      const specifier = reference === "absolute" ? first : pathToFileURL(first).href;
      await expect(plugin.read(specifier)).resolves.toMatchObject({ value: 42 });
      fs.writeFileSync(first, "export const value = 43;");
      fs.writeFileSync(path.join(pluginRoot, "later.mjs"), "export const value = 2;");
      await expect(plugin.read("source-dependency/second")).resolves.toMatchObject({ value: 84 });
      await expect(plugin.read(`${pathToFileURL(first).href}?captured`)).resolves.toMatchObject({
        value: 42,
      });
      await expect(plugin.read("./later.mjs")).resolves.toMatchObject({ value: 2 });
    },
  );

  it.each(
    [false, true].flatMap((standalone) =>
      ["static", "computed"].flatMap((reference) =>
        [false, true].map((nestedManifest) => ({ standalone, reference, nestedManifest })),
      ),
    ),
  )(
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
        "node_modules/versioned-dependency/index.mjs": "export const value = 1;",
        "nested/node_modules/versioned-dependency/package.json":
          '{"name":"versioned-dependency","version":"2.0.0","type":"module","exports":{".":"./index.mjs","./sub:entry":"./index.mjs"}}',
        "nested/node_modules/versioned-dependency/index.mjs": "export const value = 2;",
      });
      type Plugin = { rootVersion: number; readNested(name: string): Promise<number> };
      const entry = path.join(root, "entry.mjs");
      const native = createRequire(entry)(entry) as Plugin;
      expect(native.rootVersion).toBe(1);
      await expect(native.readNested("versioned-dependency/sub:entry")).resolves.toBe(2);
      await expect(native.readNested("versioned-dependency")).resolves.toBe(2);
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

  it.each(["absolute", "file URL"])(
    "retains captured dependency bytes through %s imports",
    async (reference) => {
      const root = fixture({
        "package.json": '{"dependencies":{"source-dependency":"1.0.0"}}',
        "entry.mjs": "",
        "node_modules/source-dependency/package.json":
          '{"name":"source-dependency","type":"module","exports":"./value.mjs"}',
        "node_modules/source-dependency/value.mjs": "export const value = 42;",
      });
      const dependency = path.join(root, "node_modules/source-dependency/value.mjs");
      const specifier = reference === "absolute" ? dependency : pathToFileURL(dependency).href;
      fs.writeFileSync(
        path.join(root, "entry.mjs"),
        `export const read = async () => (await import(${JSON.stringify(specifier)})).value;`,
      );
      const first = host(root).load("entry.mjs") as { read(): Promise<number> };
      fs.writeFileSync(dependency, "export const value = 43;");
      await expect(first.read()).resolves.toBe(42);
      const second = host(root).load("entry.mjs") as { read(): Promise<number> };
      await expect(second.read()).resolves.toBe(43);
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
      "shared/value.mjs": "export const value = 42;",
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

  it.each(
    ["mjs", "ts"].flatMap((extension) =>
      ["relative", "absolute", "file URL"].map((reference) => ({ extension, reference })),
    ),
  )(
    "reloads standalone $extension entries with $reference shared modules",
    async ({ extension, reference }) => {
      const root = fixture({
        "package.json": JSON.stringify({ imports: { "#answer": `./shared/answer.${extension}` } }),
        [`plugin/entry.${extension}`]: "",
        [`plugin/local.${extension}`]: "export const value = 17;",
        [`shared/value.${extension}`]: 'export { answer } from "#answer";',
        [`shared/answer.${extension}`]: "export const answer = 42;",
      });
      const shared = path.join(root, "shared", `value.${extension}`);
      const specifier =
        reference === "relative"
          ? `../shared/value.${extension}`
          : reference === "absolute"
            ? shared
            : pathToFileURL(shared).href;
      fs.writeFileSync(
        path.join(root, "plugin", `entry.${extension}`),
        `import { answer } from ${JSON.stringify(specifier)}; export const value = answer;
         export const readLocal = (specifier) => import(specifier).then(module => module.value);`,
      );
      const first = host(path.join(root, "plugin"), true).load(`entry.${extension}`) as {
        value: number;
        readLocal(specifier: string): Promise<number>;
      };
      expect(first).toMatchObject({ value: 42 });
      await expect(first.readLocal(path.join(root, "plugin", `local.${extension}`))).resolves.toBe(
        17,
      );
      fs.writeFileSync(shared, "export const answer = 43;");
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
        const target = pathToFileURL(
          path.join(root, "node_modules/source-dependency/value.ts"),
        ).href;
        fs.writeFileSync(
          path.join(root, "node_modules/source-dependency/index.ts"),
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
            export const cached = require.cache[require.resolve("./${filename}")].exports;
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
        const entry = managed.load("entry.mjs") as {
          value: Value;
          namespace: Namespace;
          required: Value;
          cached: Value;
          reexported: Value;
          answer: number;
          hidden: number;
          readNamed(): number;
          lazy(): Promise<Namespace>;
        };
        const importedValue =
          process.versions.bun && name === "own-default"
            ? (entry.required.default as Value)
            : entry.required;
        expect(entry.value.answer, name).toBe(importedValue.answer);
        expect(entry.hidden).toBe(17);
        expect(entry.value).toBe(importedValue);
        expect(entry.cached).toBe(entry.required);
        expect(managed.load(filename)).toBe(entry.required);
        expect(entry.reexported).toBe(importedValue);
        expect(entry.namespace.default).toBe(importedValue);
        expect(await entry.lazy()).toBe(entry.namespace);
        if (first) {
          expect(first).toBe(entry.namespace);
        }
        expect(entry.required.getterReads).toBe(process.versions.bun ? 1 : 0);
        entry.required.answer = 43;
        expect(entry.value.answer).toBe(importedValue === entry.required ? 43 : 0);
        expect(entry.readNamed()).toBe(42);
        expect(entry.answer).toBe(42);
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
        export const lazy = () => import("./${filename}");`,
        [emptyFilename]: "",
        "empty.cjs": `exports.load = () => import("./${emptyFilename}");`,
      });
      const entry = host(root).load("entry.mjs") as {
        current: number;
        value: number;
        namespace: { default: number; value: number };
        read(): number;
        update(): void;
        lazy(): Promise<unknown>;
      };
      expect(entry.read()).toBe(1);
      entry.update();
      expect(entry.read()).toBe(2);
      expect(entry.current).toBe(2);
      expect(entry.value).toBe(2);
      expect(entry.namespace.default).toBe(2);
      expect(await entry.lazy()).toBe(entry.namespace);
      const empty = await (host(root).load("empty.cjs") as { load(): Promise<object> }).load();
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
    const lazy = managed.load("lazy.cjs") as { load(): Promise<{ default: Promise<unknown> }> };
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
        export { value as reexported } from "conditional-dependency";
        export * as namespace from "conditional-dependency";
        export const imported = { value, token };
        function shadow(module: { exports: number }, exports: { value: number }) {
          return module.exports + exports.value;
        }
        export const shadowed = shadow({ exports: 2 }, { value: 3 });
        export const required = require("conditional-dependency");
        export const createdRequire = createRequire(import.meta.url)("conditional-dependency");
        export const lazy = () => import("conditional-dependency");
        export const lazyModule = () => import("./lazy.ts");`,
      "lazy.ts": `import { value, token } from "conditional-dependency";
        export { value, token };
        export const required = require("conditional-dependency");`,
      "node_modules/conditional-dependency/package.json": JSON.stringify({
        name: "conditional-dependency",
        type: "module",
        exports: { import: "./import.js", require: "./require.cjs" },
      }),
      "node_modules/conditional-dependency/import.js":
        'export const value = "import"; export const token = {};',
      "node_modules/conditional-dependency/require.cjs":
        'module.exports = { value: "require", token: {} };',
    });
    type Dependency = { value: string; token: object };
    const entry = host(root).load("entry.ts") as {
      imported: Dependency;
      required: Dependency;
      createdRequire: Dependency;
      reexported: string;
      namespace: Dependency;
      shadowed: number;
      lazy: () => Promise<Dependency>;
      lazyModule: () => Promise<Dependency & { required: Dependency }>;
    };
    expect(entry.imported.value).toBe("require");
    expect(entry.shadowed).toBe(5);
    expect(entry.reexported).toBe("require");
    expect(entry.namespace.token).toBe(entry.imported.token);
    expect(entry.required.value).toBe("require");
    if (process.versions.bun) {
      expect(entry.createdRequire).toEqual(entry.required);
      expect(entry.createdRequire.token).toBe(entry.required.token);
    } else {
      expect(entry.createdRequire).toBe(entry.required);
    }
    const lazy = await entry.lazy();
    expect(lazy.value).toBe("import");
    expect(lazy.token).not.toBe(entry.imported.token);
    const lazyModule = await entry.lazyModule();
    expect(lazyModule.token).toBe(lazy.token);
    if (process.versions.bun) {
      expect(lazyModule.required).toEqual(entry.required);
      expect(lazyModule.required.token).toBe(entry.required.token);
    } else {
      expect(lazyModule.required).toBe(entry.required);
    }
  });
});
