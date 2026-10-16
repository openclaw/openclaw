import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const nativeRequire = createRequire(import.meta.url);
const instances: PluginInstance[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const instance of instances.splice(0).toReversed()) {
    await instance.dispose();
  }
});

function write(root: string, files: Record<string, string>) {
  for (const [filename, source] of Object.entries(files)) {
    const target = path.join(root, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
}

function load(rootDir: string, entry: string) {
  const instance = new PluginInstance("generation-fixture");
  instances.push(instance);
  withPluginCache(createPluginCache(), () =>
    bindPluginInstanceModuleLoader({
      instance,
      origin: "config",
      source: path.join(rootDir, entry),
      rootDir,
      standalone: true,
    }),
  );
  return instance.loadModule(path.join(rootDir, entry));
}

it.each(
  ["#selected", "condition-owner/selected"].flatMap((specifier) =>
    ["import", "require"].map((mode) => ({ specifier, mode })),
  ),
)(
  "preserves native module-sync selection for selective $mode $specifier",
  ({ specifier, mode }) => {
    const root = temp.make("plugin-native-conditions-");
    const selection = { "module-sync": "./sync.mjs", import: "./import.mjs" };
    const entry = mode === "import" ? "index.mjs" : "index.cjs";
    write(root, {
      "package.json": JSON.stringify({
        name: "condition-owner",
        type: "module",
        imports: { "#selected": selection },
        exports: { "./selected": selection },
      }),
      [entry]:
        mode === "import"
          ? `export { value } from ${JSON.stringify(specifier)};`
          : `module.exports = require(${JSON.stringify(specifier)});`,
      "sync.mjs": "export const value = 'module-sync';",
      "import.mjs": "export const value = 'import';",
    });
    const native = nativeRequire(path.join(root, entry));
    expect(native.value).toBe("module-sync");
    expect(load(root, entry)).toMatchObject({ value: native.value });
  },
);

it.each(
  [
    { mode: "import", entry: "index.mjs" },
    { mode: "require", entry: "index.cjs" },
    { mode: "require", entry: "index.js" },
  ].flatMap(({ mode, entry }) =>
    ["exports", "main"].map((entryField) => ({ mode, entry, entryField })),
  ),
)(
  "retains conditional external $entryField metadata for $mode in $entry",
  async ({ mode, entry, entryField }) => {
    const root = temp.make("plugin-conditional-metadata-");
    const manifest = {
      type: entry === "index.js" ? "commonjs" : "module",
      imports: {
        "#selected": {
          "module-sync": "sync-dependency",
          import: "import-dependency",
          require: "import-dependency",
        },
        "#unused": "invalid-dependency",
      },
    };
    write(root, {
      "package.json": JSON.stringify(manifest),
      [entry]:
        mode === "import"
          ? "export const read = async () => { const loaded = await import('#selected'); return [loaded.value, loaded.body]; };"
          : "exports.read = () => { const loaded = require('#selected'); return [loaded.value, loaded.body]; };",
    });
    for (const name of ["sync-dependency", "import-dependency", "invalid-dependency"]) {
      write(path.join(root, "node_modules", name), {
        "package.json":
          name === "invalid-dependency"
            ? "invalid unselected manifest"
            : JSON.stringify({ [entryField]: "./original.mjs" }),
        "original.mjs": `export const value = '${name}'; export { body } from './body.mjs';`,
        "body.mjs": "export const body = 'before selection';",
        "replacement.mjs": "export const value = 'wrong replacement';",
      });
    }
    const plugin = load(root, entry) as { read(): string[] | Promise<string[]> };
    write(root, {
      "package.json": JSON.stringify({
        ...manifest,
        imports: { "#selected": "import-dependency" },
      }),
    });
    const selected = path.join(root, "node_modules", "sync-dependency");
    write(selected, {
      "package.json": JSON.stringify({
        [entryField]: "./replacement.mjs",
        dependencies: { "missing-later-dependency": "1.0.0" },
      }),
      "original.mjs": "export const value = 'first demand'; export { body } from './body.mjs';",
      "body.mjs": "export const body = 'selected body';",
    });
    const expected = [entryField === "main" ? "sync-dependency" : "first demand", "selected body"];
    expect(await plugin.read()).toEqual(expected);
    write(selected, {
      "original.mjs": "export const value = 'later edit';",
      "body.mjs": "export const body = 'later body';",
    });
    expect(await plugin.read()).toEqual(expected);
  },
);

it.each(["import", "require"])(
  "retains a missing selected conditional target for %s",
  async (mode) => {
    const root = temp.make("plugin-missing-conditional-target-");
    const entry = mode === "import" ? "index.mjs" : "index.cjs";
    write(root, {
      "package.json": JSON.stringify({
        type: "module",
        imports: {
          "#selected": {
            "module-sync": "./missing.mjs",
            import: "./fallback.mjs",
            require: "./fallback.mjs",
          },
        },
      }),
      "fallback.mjs": "export const value = 'wrong fallback';",
      [entry]:
        mode === "import"
          ? "export const read = async () => (await import('#selected')).value;"
          : "exports.read = async () => require('#selected').value;",
    });
    const plugin = load(root, entry) as { read(): Promise<string> };
    const expected = expect.objectContaining({
      code: mode === "import" ? "ERR_MODULE_NOT_FOUND" : "MODULE_NOT_FOUND",
    });
    await expect(plugin.read()).rejects.toEqual(expected);
    fs.writeFileSync(path.join(root, "missing.mjs"), "export const value = 'installed later';");
    await expect(plugin.read()).rejects.toEqual(expected);
    const fresh = load(root, entry) as { read(): Promise<string> };
    await expect(fresh.read()).resolves.toBe("installed later");
  },
);

it.each([
  ...["import", "require"].flatMap((mode) => ["local", "package"].map((kind) => ({ mode, kind }))),
  { mode: "require", kind: "computed alias" },
])("retains observed absent $kind inputs for $mode", async ({ mode, kind }) => {
  const root = temp.make("plugin-absent-input-");
  const computed = kind === "computed alias";
  const specifier = computed
    ? "#selected"
    : kind === "local"
      ? "./absent.mjs"
      : "absent-dependency";
  const entry = mode === "import" ? "index.mjs" : "index.cjs";
  write(root, {
    ...(computed ? { "package.json": '{"imports":{"#selected":"./missing.cjs"}}' } : {}),
    [entry]: computed
      ? "exports.read = name => require(name);"
      : mode === "import"
        ? `export const read = async () => (await import(${JSON.stringify(specifier)})).value;`
        : `exports.read = async () => require(${JSON.stringify(specifier)}).value;`,
  });
  const plugin = load(root, entry) as { read(name: string): unknown };
  if (computed) {
    expect(() => plugin.read(specifier)).toThrow();
  }
  const directory = kind === "package" ? path.join(root, "node_modules", specifier) : root;
  write(
    directory,
    computed
      ? { "missing.cjs": "module.exports = 42;" }
      : {
          ...(kind === "package" ? { "package.json": '{"main":"absent.mjs"}' } : {}),
          "absent.mjs": "export const value = 'installed';",
        },
  );
  if (computed) {
    expect(() => plugin.read(specifier)).toThrow();
  } else {
    await expect(plugin.read(specifier)).rejects.toThrow();
  }
  const fresh = load(root, entry) as { read(name: string): unknown };
  if (computed) {
    expect(fresh.read(specifier)).toBe(42);
  } else {
    await expect(fresh.read(specifier)).resolves.toBe("installed");
  }
});
it.each(["import", "require"])(
  "defers invalid optional metadata until selected by %s",
  async (mode) => {
    const root = temp.make("plugin-invalid-optional-metadata-");
    const entry = mode === "import" ? "index.mjs" : "index.cjs";
    write(root, {
      "package.json": JSON.stringify({
        imports: {
          "#selected": { "module-sync": "invalid-dependency", default: "valid-dependency" },
        },
      }),
      [entry]:
        mode === "import"
          ? "export const read = async () => (await import('#selected')).value;"
          : "exports.read = async () => require('#selected').value;",
    });
    for (const name of ["invalid-dependency", "valid-dependency"]) {
      write(path.join(root, "node_modules", name), {
        "package.json": name === "invalid-dependency" ? "invalid JSON" : '{"main":"index.cjs"}',
        "index.cjs": "exports.value = 42;",
      });
    }
    const plugin = load(root, entry) as { read(): Promise<number> };
    const invalid = expect.objectContaining({ code: "ERR_INVALID_PACKAGE_CONFIG" });
    await expect(plugin.read()).rejects.toEqual(invalid);
    fs.writeFileSync(
      path.join(root, "node_modules", "invalid-dependency", "package.json"),
      '{"main":"index.cjs"}',
    );
    await expect(plugin.read()).rejects.toEqual(invalid);
    await expect((load(root, entry) as { read(): Promise<number> }).read()).resolves.toBe(42);
  },
);

type ComputedFixture = {
  name: string;
  modes: string[];
  files: Record<string, string>;
  edits?: Record<string, string>;
  links?: Record<string, string>;
  tsconfig?: boolean;
  legacy?: boolean;
  prelude?: Record<string, string>;
  reads: [string, unknown][];
};
const computedFixtures: ComputedFixture[] = [
  ...[
    { main: "lib", filename: "lib.js" },
    { main: "lib", filename: "lib/index.js" },
    { main: undefined, filename: "index.js" },
    { main: "missing", filename: "index.js" },
  ].map(({ main, filename }) => {
    const directory = "node_modules/legacy-dependency";
    const body = `${directory}/${path.dirname(filename)}/body.cjs`;
    return {
      name: `legacy ${main} to ${filename} entry selection`,
      modes: ["import", "require"],
      legacy: true,
      files: {
        "package.json": '{"imports":{"#selected":"legacy-dependency"}}',
        [`${directory}/package.json`]: JSON.stringify({ main }),
        [`${directory}/${filename}`]:
          "exports.value = 42; exports.body = require('./body.cjs').value;",
        [body]: "exports.value = 'before';",
      },
      edits: { [body]: "exports.value = 'selected';" },
      reads: [["#selected", expect.objectContaining({ value: 42, body: "selected" })]],
    } satisfies ComputedFixture;
  }),
  {
    name: "tsconfig aliases",
    modes: ["import", "require"],
    tsconfig: true,
    files: {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@fixture/*": ["./lib/*"] } },
      }),
      "lib/value.ts": "export const value: number = 42;",
    },
    reads: [["@fixture/value", 42]],
  },
  {
    name: "prefetched legacy entry bytes through a source-file alias",
    modes: ["require"],
    files: {
      "package.json":
        '{"imports":{"#selected":"legacy-dependency","#direct":"legacy-dependency/real.cjs"}}',
      "node_modules/legacy-dependency/package.json": '{"main":"entry.cjs"}',
      "node_modules/legacy-dependency/real.cjs": "exports.value = 42;",
    },
    links: { "node_modules/legacy-dependency/entry.cjs": "real.cjs" },
    edits: { "node_modules/legacy-dependency/real.cjs": "exports.value = 84;" },
    // Selecting the physical alias first must promote the retained package too.
    reads: [
      ["#direct", 42],
      ["#selected", 42],
      ["#direct", 42],
    ],
  },
  {
    name: "wildcard trailer precedence",
    modes: ["import", "require"],
    files: {
      "package.json": JSON.stringify({
        imports: { "#selected/*": "./broad.cjs", "#selected/*.js": "./specific.cjs" },
      }),
      "broad.cjs": "exports.value = 'broad';",
      "specific.cjs": "exports.value = 'specific';",
    },
    // Retain both local branches before testing native wildcard precedence.
    prelude: {
      import: "import './broad.cjs'; import './specific.cjs';",
      require: "require('./broad.cjs'); require('./specific.cjs');",
    },
    reads: [["#selected/leaf.js", "specific"]],
  },
  {
    name: "unselected native runtime alias exclusion",
    modes: ["require"],
    files: {
      "package.json": JSON.stringify({
        imports: { "#selected": { bun: "bun-dependency", default: "node-dependency" } },
      }),
      ...Object.fromEntries(
        ["bun-dependency", "node-dependency"].flatMap((name) => [
          [
            `node_modules/${name}/package.json`,
            JSON.stringify({
              main: "index.cjs",
              ...(name === (process.versions.bun ? "bun-dependency" : "node-dependency")
                ? {}
                : { dependencies: { "unselected-missing-dependency": "1.0.0" } }),
            }),
          ],
          [`node_modules/${name}/index.cjs`, "exports.value = 42;"],
        ]),
      ),
    },
    reads: [["#selected", 42]],
  },
];
it.each(computedFixtures.flatMap((fixture) => fixture.modes.map((mode) => ({ ...fixture, mode }))))(
  "preserves computed $name for $mode",
  async ({ mode, files, edits, links, tsconfig, legacy, prelude, reads }) => {
    if (tsconfig) {
      vi.stubEnv("JITI_TSCONFIG_PATHS", "true");
    }
    const root = temp.make("plugin-computed-resolution-");
    write(root, files);
    for (const [filename, target] of Object.entries(links ?? {})) {
      fs.symlinkSync(target, path.join(root, filename));
    }
    const entry = mode === "import" ? (tsconfig ? "index.ts" : "index.mjs") : "index.cjs";
    // Legacy operands stay opaque to the static reference collector.
    const parameter = legacy ? "" : tsconfig && mode === "import" ? "name: string" : "name";
    const source =
      mode === "import"
        ? `export const read = async (${parameter}) => (await import(name)).${legacy ? "default" : "value"};`
        : `exports.read = ${legacy ? "async " : ""}(${parameter}) => require(name)${legacy ? "" : ".value"};`;
    write(root, {
      [entry]: `${prelude?.[mode] ?? ""} ${legacy ? "const name = '#selected';" : ""} ${source}`,
    });
    const plugin = load(root, entry) as { read(name: string): unknown };
    write(root, edits ?? {});
    for (const [specifier, expected] of reads) {
      expect(await plugin.read(specifier)).toEqual(expected);
    }
  },
);
it.each(
  ["import", "require"].flatMap((mode) =>
    [
      "bun:sqlite",
      "bun:missing-builtin",
      "bun:sqlite?invalid",
      "node:path",
      ["bun:sqlite", "./fallback.cjs"],
    ].map((target) => ({ mode, target })),
  ),
)(
  "preserves native $mode package-import validation and fallback for $target",
  async ({ mode, target }) => {
    const root = temp.make("plugin-native-builtin-alias-");
    write(root, {
      "package.json": JSON.stringify({ imports: { "#builtin": target } }),
      ...(Array.isArray(target) ? { "fallback.cjs": "exports.Database = 'fallback';" } : {}),
      "index.cjs":
        mode === "import"
          ? "exports.read = name => import(name).then(value => typeof value.Database);"
          : "exports.read = name => typeof require(name).Database;",
    });
    const outcome = async (plugin: { read(name: string): unknown }) => {
      try {
        return { value: await plugin.read("#builtin") };
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error)) {
          throw error;
        }
        return { code: error.code };
      }
    };
    const expected = await outcome(nativeRequire(path.join(root, "index.cjs")));
    if (Array.isArray(target)) {
      // Built-in URL targets in arrays retain Node's fallback semantics.
      expect(expected).toEqual({ value: "string" });
    } else if (target !== "bun:sqlite") {
      expect(expected).toEqual({ code: "ERR_INVALID_PACKAGE_TARGET" });
    } else if ("value" in expected) {
      expect(expected.value).toBe("function");
    }
    const plugin = load(root, "index.cjs") as { read(name: string): unknown };
    expect(await outcome(plugin)).toEqual(expected);
  },
);

it("scopes observed package-map absences to the target selected by custom conditions", async () => {
  const home = temp.make("plugin-custom-condition-absence-");
  const roots = ["import", "require"].map((mode) => {
    const root = path.join(home, mode);
    fs.mkdirSync(root, { mode: 0o700 });
    const filename = mode === "import" ? "index.mjs" : "index.cjs";
    const entry = path.join(root, filename);
    write(root, {
      "package.json": JSON.stringify({
        imports: {
          "#selected": { "openclaw-custom": "./valid.cjs", default: "./missing.cjs" },
          "#late": "./missing.cjs",
        },
      }),
      "valid.cjs": "exports.value = 42;",
      [filename]:
        mode === "import"
          ? "export const read = async () => (await import('#selected')).default.value; export const readLate = async () => (await import('#late')).default.value;"
          : "exports.read = () => require('#selected').value; exports.readLate = () => require('#late').value;",
    });
    return { root, entry };
  });
  const moduleUrl = (filename: string) => pathToFileURL(path.resolve("src/plugins", filename)).href;
  const probe = path.join(home, "probe.mts");
  fs.writeFileSync(
    probe,
    `import assert from 'node:assert/strict';
     import fs from 'node:fs';
     import path from 'node:path';
     import { createPluginCache, withPluginCache } from ${JSON.stringify(moduleUrl("plugin-cache.ts"))};
     import { bindPluginInstanceModuleLoader } from ${JSON.stringify(moduleUrl("plugin-instance-module-loader.ts"))};
     import { PluginInstance } from ${JSON.stringify(moduleUrl("plugin-instance.ts"))};
     const values = [];
     for (const { root, entry } of ${JSON.stringify(roots)}) {
       const instances = [];
       const load = () => {
         const instance = new PluginInstance('custom-condition-fixture');
         instances.push(instance);
         withPluginCache(createPluginCache(), () => bindPluginInstanceModuleLoader({
           instance, origin: 'config', source: entry, rootDir: root, standalone: true,
         }));
         return instance.loadModule(entry);
       };
       try {
         const plugin = load();
         fs.writeFileSync(path.join(root, 'missing.cjs'), 'exports.value = 84;');
         values.push(await plugin.read());
         await assert.rejects(async () => await plugin.readLate());
         assert.equal(await load().readLate(), 84);
       } finally {
         for (const instance of instances.toReversed()) await instance.dispose();
       }
     }
     console.log(JSON.stringify(values));`,
  );
  const state = path.join(home, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  const result = await runNodeScript(
    [
      "--conditions=openclaw-custom",
      ...(process.versions.bun
        ? ["--no-install"]
        : ["--import", pathToFileURL(path.resolve("scripts/tsx.mjs")).href]),
      probe,
    ],
    { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, OPENCLAW_STATE_DIR: state },
    undefined,
    { executable: process.execPath },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([42, 42]);
});

// Native erasure keeps specifier-only empty requests; the existing Node/Jiti adapter removes them.
it.each([
  ["import type", "import type { Shape } from '#selected';", "after"],
  [
    "type import specifier",
    "import { type Shape } from '#selected';",
    process.versions.bun ? "before" : "after",
  ],
  ["implicit type import", "import { Shape } from '#selected'; type Alias = Shape;", "after"],
  ["export type", "export type { Shape } from '#selected';", "after"],
  [
    "type export specifier",
    "export { type Shape } from '#selected';",
    process.versions.bun ? "before" : "after",
  ],
  ["export type all", "export type * from '#selected';", "after"],
  ["side-effect import", "import '#selected';", "before"],
  [
    "mixed runtime import",
    "import { type Shape, value } from '#selected'; export const observed = value;",
    "before",
  ],
  ["mixed runtime export", "export { type Shape, value } from '#selected';", "before"],
])("acquires the dependency body at runtime after %s", (_name, declaration, expected) => {
  const root = temp.make("plugin-type-only-reference-");
  const dependency = path.join(root, "node_modules", "selected-dependency");
  write(root, {
    "package.json": '{"imports":{"#selected":"selected-dependency"}}',
    // A computed import exercises Bun's native TypeScript adapter.
    "index.ts": `${declaration}
      export const read = () => require('#selected').value;
      export const load = async (name: string) => import(name);`,
  });
  write(dependency, {
    "package.json": '{"exports":"./index.cjs"}',
    "index.cjs": "exports.value = require('./body.cjs').value;",
    "body.cjs": "exports.value = 'before';",
  });
  const plugin = load(root, "index.ts") as { read(): string };
  fs.writeFileSync(path.join(dependency, "body.cjs"), "exports.value = 'after';");
  expect(plugin.read()).toBe(expected);
});

it.each(["declared", "alias", "undeclared"])(
  "preserves %s nested dependency capture timing for a deferred entry",
  (kind) => {
    const root = temp.make("plugin-deferred-entry-facts-");
    const outer = path.join(root, "node_modules", "outer-dependency");
    const inner = path.join(outer, "node_modules", "inner-dependency");
    write(root, {
      "package.json": '{"imports":{"#outer":"outer-dependency"}}',
      "index.cjs": "exports.select = () => require('#outer');",
    });
    write(outer, {
      "package.json": JSON.stringify({
        exports: "./index.cjs",
        ...(kind === "declared"
          ? { dependencies: { "inner-dependency": "1.0.0" } }
          : kind === "alias"
            ? { imports: { "#inner": "inner-dependency" } }
            : {}),
      }),
      "index.cjs": `exports.read = () => require(${JSON.stringify(kind === "alias" ? "#inner" : "inner-dependency")}).value;`,
    });
    write(inner, {
      "package.json": '{"exports":"./index.cjs"}',
      "index.cjs": "exports.value = require('./body.cjs').value;",
      "body.cjs": "exports.value = 'before-load';",
    });
    const body = path.join(inner, "body.cjs");
    const plugin = load(root, "index.cjs") as { select(): { read(): string } };
    fs.writeFileSync(body, "exports.value = 'before-selection';");
    const selected = plugin.select();
    fs.writeFileSync(body, "exports.value = 'after-selection';");
    expect(selected.read()).toBe(kind === "declared" ? "before-selection" : "after-selection");
    fs.writeFileSync(body, "exports.value = 'after-first-read';");
    expect(selected.read()).toBe(kind === "declared" ? "before-selection" : "after-selection");
  },
);
