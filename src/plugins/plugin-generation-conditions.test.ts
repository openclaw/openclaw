import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { bindPluginInstanceModuleLoader } from "./plugin-module-loader-cache.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const nativeRequire = createRequire(import.meta.url);
const instances: PluginInstance[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const instance of instances.splice(0).toReversed()) {
    await instance.dispose();
  }
});

function load(rootDir: string, entry: string, standalone = false) {
  const instance = new PluginInstance("generation-fixture");
  instances.push(instance);
  withPluginCache(createPluginCache(), () =>
    bindPluginInstanceModuleLoader({
      instance,
      origin: "config",
      source: path.join(rootDir, entry),
      rootDir,
      standalone,
    }),
  );
  return { instance, value: instance.loadModule(path.join(rootDir, entry)) };
}

describe("captured module conditions", () => {
  it.each(
    ["#selected", "condition-owner/selected"].flatMap((specifier) =>
      ["import", "require"].map((mode) => ({ specifier, mode })),
    ),
  )(
    "preserves native module-sync selection for selective $mode $specifier",
    ({ specifier, mode }) => {
      const root = temp.make("plugin-native-conditions-");
      const selection = { "module-sync": "./sync.mjs", import: "./import.mjs" };
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "condition-owner",
          type: "module",
          imports: { "#selected": selection },
          exports: { "./selected": selection },
        }),
      );
      const entry = mode === "import" ? "index.mjs" : "index.cjs";
      fs.writeFileSync(
        path.join(root, entry),
        mode === "import"
          ? `export { value } from ${JSON.stringify(specifier)};`
          : `module.exports = require(${JSON.stringify(specifier)});`,
      );
      fs.writeFileSync(path.join(root, "sync.mjs"), "export const value = 'module-sync';");
      fs.writeFileSync(path.join(root, "import.mjs"), "export const value = 'import';");
      const native = nativeRequire(path.join(root, entry));
      expect(native.value).toBe("module-sync");
      expect(load(root, entry, true).value).toMatchObject({ value: native.value });
    },
  );

  it.each(
    ["import", "require"].flatMap((mode) =>
      ["exports", "main"].map((entryField) => ({ mode, entryField })),
    ),
  )("retains conditional external $entryField metadata for $mode", async ({ mode, entryField }) => {
    const root = temp.make("plugin-conditional-metadata-");
    const manifest = {
      type: "module",
      imports: {
        "#selected": {
          "module-sync": "sync-dependency",
          import: "import-dependency",
          require: "import-dependency",
        },
        "#unused": "invalid-dependency",
      },
    };
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    const entry = mode === "import" ? "index.mjs" : "index.cjs";
    fs.writeFileSync(
      path.join(root, entry),
      mode === "import"
        ? "export const read = async () => { const loaded = await import('#selected'); return [loaded.value, loaded.body]; };"
        : "exports.read = () => { const loaded = require('#selected'); return [loaded.value, loaded.body]; };",
    );
    for (const name of ["sync-dependency", "import-dependency", "invalid-dependency"]) {
      const directory = path.join(root, "node_modules", name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "package.json"),
        name === "invalid-dependency"
          ? "invalid unselected manifest"
          : JSON.stringify({ [entryField]: "./original.mjs" }),
      );
      fs.writeFileSync(
        path.join(directory, "original.mjs"),
        `export const value = '${name}'; export { body } from './body.mjs';`,
      );
      fs.writeFileSync(path.join(directory, "body.mjs"), "export const body = 'before selection';");
      fs.writeFileSync(
        path.join(directory, "replacement.mjs"),
        "export const value = 'wrong replacement';",
      );
    }
    const plugin = load(root, entry, true).value as { read(): string[] | Promise<string[]> };
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ ...manifest, imports: { "#selected": "import-dependency" } }),
    );
    const selected = path.join(root, "node_modules", "sync-dependency");
    fs.writeFileSync(
      path.join(selected, "package.json"),
      JSON.stringify({
        [entryField]: "./replacement.mjs",
        dependencies: { "missing-later-dependency": "1.0.0" },
      }),
    );
    fs.writeFileSync(
      path.join(selected, "original.mjs"),
      "export const value = 'first demand'; export { body } from './body.mjs';",
    );
    fs.writeFileSync(path.join(selected, "body.mjs"), "export const body = 'selected body';");
    const expected = [entryField === "main" ? "sync-dependency" : "first demand", "selected body"];
    expect(await plugin.read()).toEqual(expected);
    fs.writeFileSync(path.join(selected, "original.mjs"), "export const value = 'later edit';");
    fs.writeFileSync(path.join(selected, "body.mjs"), "export const body = 'later body';");
    expect(await plugin.read()).toEqual(expected);
  });

  it.each(["import", "require"])(
    "retains a missing selected conditional target for %s",
    async (mode) => {
      const root = temp.make("plugin-missing-conditional-target-");
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          type: "module",
          imports: {
            "#selected": {
              "module-sync": "./missing.mjs",
              import: "./fallback.mjs",
              require: "./fallback.mjs",
            },
          },
        }),
      );
      fs.writeFileSync(path.join(root, "fallback.mjs"), "export const value = 'wrong fallback';");
      const entry = mode === "import" ? "index.mjs" : "index.cjs";
      fs.writeFileSync(
        path.join(root, entry),
        mode === "import"
          ? "export const read = async () => (await import('#selected')).value;"
          : "exports.read = async () => require('#selected').value;",
      );
      const plugin = load(root, entry, true).value as { read(): Promise<string> };
      const expected = expect.objectContaining({
        code: mode === "import" ? "ERR_MODULE_NOT_FOUND" : "MODULE_NOT_FOUND",
      });
      await expect(plugin.read()).rejects.toEqual(expected);
      fs.writeFileSync(path.join(root, "missing.mjs"), "export const value = 'installed later';");
      await expect(plugin.read()).rejects.toEqual(expected);
      const fresh = load(root, entry, true).value as { read(): Promise<string> };
      await expect(fresh.read()).resolves.toBe("installed later");
    },
  );

  it.each(
    ["import", "require"].flatMap((mode) => ["local", "package"].map((kind) => ({ mode, kind }))),
  )("retains observed absent $kind inputs for $mode", async ({ mode, kind }) => {
    const root = temp.make("plugin-absent-input-");
    const specifier = kind === "local" ? "./absent.mjs" : "absent-dependency";
    const entry = mode === "import" ? "index.mjs" : "index.cjs";
    fs.writeFileSync(
      path.join(root, entry),
      mode === "import"
        ? `export const read = async () => (await import(${JSON.stringify(specifier)})).value;`
        : `exports.read = async () => require(${JSON.stringify(specifier)}).value;`,
    );
    const plugin = load(root, entry, true).value as { read(): Promise<string> };
    const directory = kind === "local" ? root : path.join(root, "node_modules", specifier);
    fs.mkdirSync(directory, { recursive: true });
    if (kind === "package") {
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ main: "absent.mjs" }),
      );
    }
    fs.writeFileSync(path.join(directory, "absent.mjs"), "export const value = 'installed';");
    await expect(plugin.read()).rejects.toThrow();
    const fresh = load(root, entry, true).value as { read(): Promise<string> };
    await expect(fresh.read()).resolves.toBe("installed");
  });
  it.each(["import", "require"])(
    "defers invalid optional metadata until selected by %s",
    async (mode) => {
      const root = temp.make("plugin-invalid-optional-metadata-");
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          imports: {
            "#selected": { "module-sync": "invalid-dependency", default: "valid-dependency" },
          },
        }),
      );
      for (const name of ["invalid-dependency", "valid-dependency"]) {
        const directory = path.join(root, "node_modules", name);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, "package.json"),
          name === "invalid-dependency" ? "invalid JSON" : '{"main":"index.cjs"}',
        );
        fs.writeFileSync(path.join(directory, "index.cjs"), "exports.value = 42;");
      }
      const entry = mode === "import" ? "index.mjs" : "index.cjs";
      fs.writeFileSync(
        path.join(root, entry),
        mode === "import"
          ? "export const read = async () => (await import('#selected')).value;"
          : "exports.read = async () => require('#selected').value;",
      );
      const plugin = load(root, entry, true).value as { read(): Promise<number> };
      const invalid = expect.objectContaining({ code: "ERR_INVALID_PACKAGE_CONFIG" });
      await expect(plugin.read()).rejects.toEqual(invalid);
      fs.writeFileSync(
        path.join(root, "node_modules", "invalid-dependency", "package.json"),
        '{"main":"index.cjs"}',
      );
      await expect(plugin.read()).rejects.toEqual(invalid);
      await expect(
        (load(root, entry, true).value as { read(): Promise<number> }).read(),
      ).resolves.toBe(42);
    },
  );

  it.each(
    ["import", "require"].flatMap((mode) =>
      [
        { main: "lib", filename: "lib.js" },
        { main: "lib", filename: "lib/index.js" },
        { main: undefined, filename: "index.js" },
        { main: "missing", filename: "index.js" },
      ].map(({ main, filename }) => ({ mode, main, filename })),
    ),
  )(
    "preserves legacy $main to $filename entry selection for $mode",
    async ({ mode, main, filename }) => {
      const root = temp.make("plugin-legacy-entry-candidates-");
      const dependency = path.join(root, "node_modules", "legacy-dependency");
      const file = path.join(dependency, filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        path.join(root, "package.json"),
        '{"imports":{"#selected":"legacy-dependency"}}',
      );
      fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ main }));
      fs.writeFileSync(file, "exports.value = 42; exports.body = require('./body.cjs').value;");
      fs.writeFileSync(path.join(path.dirname(file), "body.cjs"), "exports.value = 'before';");
      const entry = mode === "import" ? "index.mjs" : "index.cjs";
      fs.writeFileSync(
        path.join(root, entry),
        mode === "import"
          ? "export const read = async () => (await import('#selected')).default;"
          : "exports.read = async () => require('#selected');",
      );
      // Use an opaque operand so the static reference collector does not materialize this body.
      const source = fs.readFileSync(path.join(root, entry), "utf8").replace("'#selected'", "name");
      fs.writeFileSync(path.join(root, entry), `const name = '#selected'; ${source}`);
      const plugin = load(root, entry, true).value as {
        read(): Promise<{ value: number; body: string }>;
      };
      fs.writeFileSync(path.join(path.dirname(file), "body.cjs"), "exports.value = 'selected';");
      await expect(plugin.read()).resolves.toMatchObject({ value: 42, body: "selected" });
    },
  );
  it.each(["import", "require"])("retains computed tsconfig aliases for %s", async (mode) => {
    vi.stubEnv("JITI_TSCONFIG_PATHS", "true");
    const root = temp.make("plugin-computed-tsconfig-alias-");
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@fixture/*": ["./lib/*"] } } }),
    );
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "lib", "value.ts"), "export const value: number = 42;");
    const entry = mode === "import" ? "index.ts" : "index.cjs";
    fs.writeFileSync(
      path.join(root, entry),
      mode === "import"
        ? "export const read = async (name: string) => (await import(name)).value;"
        : "exports.read = name => require(name).value;",
    );
    const plugin = load(root, entry, true).value as {
      read(name: string): number | Promise<number>;
    };
    expect(await plugin.read("@fixture/value")).toBe(42);
  });
  it("preserves prefetched legacy entry bytes through a source-file alias", async () => {
    const root = temp.make("plugin-legacy-entry-alias-");
    const dependency = path.join(root, "node_modules", "legacy-dependency");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      '{"imports":{"#selected":"legacy-dependency","#direct":"legacy-dependency/real.cjs"}}',
    );
    fs.writeFileSync(path.join(dependency, "package.json"), '{"main":"entry.cjs"}');
    fs.writeFileSync(path.join(dependency, "real.cjs"), "exports.value = 42;");
    fs.symlinkSync("real.cjs", path.join(dependency, "entry.cjs"));
    fs.writeFileSync(path.join(root, "index.cjs"), "exports.read = name => require(name).value;");
    const plugin = load(root, "index.cjs", true).value as { read(name: string): number };
    fs.writeFileSync(path.join(dependency, "real.cjs"), "exports.value = 84;");
    expect(plugin.read("#selected")).toBe(42);
    expect(plugin.read("#direct")).toBe(42);
  });
});
