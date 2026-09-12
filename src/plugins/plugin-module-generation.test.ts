import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createJiti } from "jiti";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
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

describe("plugin module generations", () => {
  it.runIf(process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1")(
    "reloads Bun plugin generations while retained callers keep their original modules",
    () => {
      const home = temp.make("plugin-bun-generations-");
      const result = spawnSync(
        process.env.BUN_BIN ?? "bun",
        ["--no-install", "src/plugins/plugin-module-generation.bun.test-support.ts", home],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: home,
            USERPROFILE: home,
            TMPDIR: home,
            OPENCLAW_STATE_DIR: path.join(home, "state"),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.each([
    ...["ts", "mts", "mtsx"].flatMap((extension) =>
      ["commonjs", undefined].map((type) => ({ extension, type, importOnly: false })),
    ),
    ...["commonjs", undefined].map((type) => ({ extension: "ts", type, importOnly: true })),
  ])(
    "preserves synchronous $extension startup conditions in a $type package across reload (import-only: $importOnly)",
    ({ type, extension, importOnly }) => {
      const root = temp.make("plugin-source-startup-conditions-");
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          type,
          dependencies: { "conditional-dependency": "1.0.0" },
          ...(importOnly
            ? { imports: { "#conditional": { import: "conditional-dependency" } } }
            : {}),
        }),
      );
      const dependency = path.join(root, "node_modules", "conditional-dependency");
      fs.mkdirSync(dependency, { recursive: true });
      fs.writeFileSync(
        path.join(dependency, "package.json"),
        JSON.stringify({
          exports: { import: "./import.mjs", ...(importOnly ? {} : { require: "./require.cjs" }) },
        }),
      );
      fs.writeFileSync(path.join(dependency, "import.mjs"), "export const value = 99;");
      const required = path.join(dependency, "require.cjs");
      fs.writeFileSync(required, "exports.value = 42;");
      fs.writeFileSync(
        path.join(root, "helper.ts"),
        'export { value } from "conditional-dependency";',
      );
      fs.writeFileSync(
        path.join(root, "unvisited.ts"),
        'export { value } from "conditional-dependency";',
      );
      const entry = `index.${extension}`;
      const source = path.join(root, entry);
      fs.writeFileSync(
        source,
        `import { createRequire } from "node:module";
         import { value as direct } from "conditional-dependency";
         import { value as helper } from "./helper.js";
         export { value as reexported } from "./helper.js";
         export { direct, helper };
         export const resolveThenRequire = () => {
           import.meta.resolve('./unvisited.ts');
           return require('./unvisited.ts').value;
         };
         export const resolve = () => require.resolve('conditional-dependency');
         export const alias = () => require('#conditional').value;
         export const nativeResolve = () => createRequire(import.meta.url).resolve('conditional-dependency');
         export const requireProperties = () => {
           const native = createRequire(import.meta.url);
           return [require.cache === native.cache, require.extensions === native.extensions,
             require.main === native.main,
             JSON.stringify(require.resolve.paths('conditional-dependency')) === JSON.stringify(native.resolve.paths('conditional-dependency'))];
         };`,
      );
      const value = importOnly ? 99 : 42;
      const expected = { direct: value, helper: value, reexported: value };
      type StartupPlugin = typeof expected & {
        resolveThenRequire(): number;
        resolve(): string;
        alias(): number;
        nativeResolve(): string;
        requireProperties(): boolean[];
      };
      const legacy = createJiti(source, {
        tryNative: false,
        fsCache: false,
        moduleCache: false,
        interopDefault: false,
      })(source) as StartupPlugin;
      expect(legacy).toMatchObject(expected);
      expect(legacy.resolveThenRequire()).toBe(value);
      const first = load(root, entry).value as StartupPlugin;
      expect(first).toMatchObject(expected);
      expect(first.resolveThenRequire()).toBe(value);
      expect(first.requireProperties()).toEqual([true, true, true, true]);
      expect(first.resolve()).toMatch(importOnly ? /import\.mjs$/ : /require\.cjs$/);
      if (importOnly) {
        expect(legacy.alias()).toBe(value);
        expect(first.alias()).toBe(value);
        expect(() => legacy.nativeResolve()).toThrow(
          expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
        );
        expect(() => first.nativeResolve()).toThrow(
          expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
        );
      }
      fs.writeFileSync(
        importOnly ? path.join(dependency, "import.mjs") : required,
        importOnly ? "export const value = 100;" : "exports.value = 43;",
      );
      const next = load(root, entry).value as StartupPlugin;
      expect(next).toMatchObject({
        direct: value + 1,
        helper: value + 1,
        reexported: value + 1,
      });
      expect(next.resolveThenRequire()).toBe(value + 1);
      expect(first).toMatchObject(expected);
      expect(first.resolveThenRequire()).toBe(value);
    },
  );

  it.each(["ts", "mts", "mtsx"])(
    "preserves synchronous %s import.meta and native createRequire behavior",
    (extension) => {
      const root = temp.make("plugin-source-import-meta-");
      fs.mkdirSync(path.join(root, "nested"));
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          type: "module",
          imports: { "#helper": "./nested/helper.mjs" },
          dependencies: { "conditional-dependency": "1.0.0" },
        }),
      );
      fs.writeFileSync(path.join(root, "nested/helper.mjs"), "export const value = 1;");
      const dependency = path.join(root, "node_modules/conditional-dependency");
      fs.mkdirSync(dependency, { recursive: true });
      fs.writeFileSync(
        path.join(dependency, "package.json"),
        JSON.stringify({
          exports: { import: "./import.mjs", require: "./require.cjs" },
        }),
      );
      fs.writeFileSync(path.join(dependency, "import.mjs"), "export const value = 'import';");
      fs.writeFileSync(
        path.join(dependency, "require.cjs"),
        "module.exports = { value: 'require' };",
      );
      const entry = `nested/index.${extension}`;
      const source = path.join(root, entry);
      fs.writeFileSync(
        source,
        `
        import { createRequire } from 'node:module';
        import { fileURLToPath } from 'node:url';
        import path from 'node:path';
        const require = createRequire(import.meta.url);
        const module = 'local-module', exports = 'local-exports';
        const __filename = 'local-file', __dirname = 'local-directory';
        const locals = { module, exports, __filename, __dirname };
        export const read = () => [
          fileURLToPath(import.meta.url) === import.meta.filename,
          path.dirname(import.meta.filename) === import.meta.dirname,
          import.meta.resolve('./helper.mjs') === import.meta.resolve('#helper'),
          import.meta.resolve('conditional-dependency').endsWith('/import.mjs'),
          require('conditional-dependency').value,
          import.meta.env === process.env,
          locals,
        ];
      `,
      );
      const legacy = createJiti(source, { tryNative: false, fsCache: false, moduleCache: false })(
        source,
      ) as { read(): unknown[] };
      const expected = [
        true,
        true,
        true,
        true,
        "require",
        true,
        {
          module: "local-module",
          exports: "local-exports",
          __filename: "local-file",
          __dirname: "local-directory",
        },
      ];
      expect(legacy.read()).toEqual(expected);
      const current = load(root, entry).value as typeof legacy;
      expect(current.read()).toEqual(expected);
    },
  );

  it.each(["ts", "mjs"])("awaits first-demand %s top-level await", async (extension) => {
    const root = temp.make("plugin-async-source-demand-");
    const source = path.join(root, "index.ts");
    fs.writeFileSync(
      source,
      `export const read = () => import('./helper.${extension}').then(module => [module.value, module.default]);`,
    );
    fs.writeFileSync(
      path.join(root, `helper.${extension}`),
      "export const value = await Promise.resolve(42); export default value;",
    );
    const legacy = createJiti(source, { tryNative: false, fsCache: false, moduleCache: false })(
      source,
    ) as { read(): Promise<number[]> };
    await expect(legacy.read()).resolves.toEqual([42, 42]);
    const current = load(root, "index.ts").value as typeof legacy;
    await expect(current.read()).resolves.toEqual([42, 42]);
  });

  it.each([
    ["named ESM", "mjs", "export const value = 42;", [42, 42, null]],
    [
      "default object",
      "mjs",
      "export default { value: 42, read() { return this.value; } };",
      [42, 42, 42],
    ],
    ["default function", "mjs", "export const value = 7; export default () => 42;", [7, 42, null]],
    [
      "CommonJS object",
      "cjs",
      "module.exports = { value: 42, read() { return this.value; } };",
      [42, 42, 42],
    ],
    [
      "CommonJS default function",
      "cjs",
      "Object.defineProperty(exports, '__esModule', { value: true }); exports.default = () => 42; exports.value = 7;",
      [7, 42, null],
    ],
    ["JSON", "json", '{"value":42}', [42, 42, null]],
    ["JSON null", "json", "null", [undefined, null, null]],
  ] as const)(
    "preserves Jiti dynamic import interop for %s",
    async (_label, extension, body, expected) => {
      const root = temp.make("plugin-source-dynamic-interop-");
      const source = path.join(root, "index.ts");
      fs.writeFileSync(path.join(root, `value.${extension}`), body);
      fs.writeFileSync(
        source,
        `export const read = async () => {
      const module = await import('./value.${extension}');
      return [module.value, typeof module.default === 'function' ? module.default() : module.default === null ? null : module.default.value,
        typeof module.read === 'function' ? module.read() : null];
    };`,
      );
      const legacy = createJiti(source, { tryNative: false, fsCache: false, moduleCache: false })(
        source,
      ) as { read(): Promise<unknown[]> };
      await expect(legacy.read()).resolves.toEqual(expected);
      const current = load(root, "index.ts").value as typeof legacy;
      await expect(current.read()).resolves.toEqual(expected);
    },
  );

  it.each(["mjs", "ts"])("preserves computed import URL identity (%s)", async (extension) => {
    const root = temp.make("plugin-computed-url-");
    fs.writeFileSync(
      path.join(root, `index.${extension}`),
      "export const read = name => import(name);",
    );
    fs.writeFileSync(
      path.join(root, `helper.${extension}`),
      "export const token = Symbol('module');",
    );
    const plugin = load(root, `index.${extension}`, true).value as {
      read(name: string): Promise<{ token: symbol }>;
    };
    const target = extension === "ts" ? "./helper.js" : "./helper.mjs";
    const query = await plugin.read(`${target}?one`);
    const fragment = await plugin.read(`${target}#two`);
    const plain = await plugin.read(target);
    expect((await plugin.read(`${target}?one`)).token).toBe(query.token);
    expect((await plugin.read(`${target}#two`)).token).toBe(fragment.token);
    expect(query.token).not.toBe(plain.token);
    expect(fragment.token).not.toBe(plain.token);
    expect(fragment.token).not.toBe(query.token);
  });

  it("retains a failed computed package capture through another export path", () => {
    const root = temp.make("plugin-failed-computed-package-");
    fs.writeFileSync(path.join(root, "index.cjs"), "exports.read = name => require(name).value;");
    const dependency = path.join(root, "node_modules", "failed-dependency");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({
        main: "index.cjs",
        dependencies: { "missing-required-dependency": "1.0.0" },
      }),
    );
    fs.writeFileSync(path.join(dependency, "index.cjs"), "exports.value = 42;");
    const plugin = load(root, "index.cjs", true).value as { read(name: string): number };
    expect(() => plugin.read("failed-dependency")).toThrow("missing-required-dependency");
    expect(() => plugin.read("failed-dependency/index.cjs")).toThrow("missing-required-dependency");
  });

  it.each(["ts", "mts"])(
    "reports unsupported synchronous TypeScript top-level await (%s)",
    (extension) => {
      const root = temp.make("plugin-async-native-module-");
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
      const entry = `index.${extension}`;
      fs.writeFileSync(
        path.join(root, entry),
        `import type { module, exports } from 'type-only-uninstalled';
         export const value = await Promise.resolve(42);`,
      );
      const source = path.join(root, entry);
      expect(() =>
        createJiti(source, { tryNative: false, fsCache: false, moduleCache: false })(source),
      ).toThrow(/await/);
      expect(() => load(root, entry)).toThrow(/await/);
    },
  );

  it.each([
    ...["type", "runtime"].flatMap((imports) =>
      ["module", "exports", "export-equals"].map((assignment) => ({ imports, assignment })),
    ),
    { imports: "none", assignment: "export-equals" },
    { imports: "require", assignment: "export-equals" },
    { imports: "require-import-only", assignment: "export-equals" },
  ])(
    "preserves authored $assignment CommonJS exports beside $imports imports",
    ({ imports, assignment }) => {
      const root = temp.make("plugin-type-only-commonjs-");
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ type: "commonjs", dependencies: { "conditional-dependency": "1.0.0" } }),
      );
      const dependency = path.join(root, "node_modules", "conditional-dependency");
      fs.mkdirSync(dependency, { recursive: true });
      fs.writeFileSync(
        path.join(dependency, "package.json"),
        JSON.stringify({
          exports: {
            import: "./import.mjs",
            ...(imports === "require-import-only" ? {} : { require: "./require.cjs" }),
          },
        }),
      );
      fs.writeFileSync(path.join(dependency, "import.mjs"), "export const value = 99;");
      fs.writeFileSync(path.join(dependency, "require.cjs"), "exports.value = 42;");
      const source = path.join(root, "index.ts");
      const value = imports === "runtime" || imports.startsWith("require") ? "value" : "42";
      const declaration =
        imports === "type"
          ? "import type { Missing } from 'type-only-uninstalled';"
          : imports === "runtime"
            ? "import { value } from 'conditional-dependency';"
            : imports.startsWith("require")
              ? "import dependency = require('conditional-dependency'); const { value } = dependency;"
              : "";
      fs.writeFileSync(
        source,
        `${declaration}
         ${assignment === "exports" ? `exports.value = ${value};` : `${assignment === "module" ? "module.exports" : "export"} = { value: ${value} };`}`,
      );
      const legacy = createJiti(source, {
        tryNative: false,
        fsCache: false,
        moduleCache: false,
        interopDefault: false,
      })(source);
      expect(legacy).toEqual({ value: imports === "require-import-only" ? 99 : 42 });
      expect(load(root, "index.ts").value).toEqual(legacy);
    },
  );

  it.each(
    ["javascript", "typescript"].flatMap((language) =>
      ["require", "import"].flatMap((mode) =>
        ["local", "package"].map((dependency) => ({ language, mode, dependency })),
      ),
    ),
  )(
    "captures computed $language $mode $dependency edges on first demand",
    async ({ language, mode, dependency }) => {
      const root = temp.make("plugin-computed-generation-");
      const typescript = language === "typescript";
      const entry = typescript ? "index.ts" : mode === "require" ? "index.cjs" : "index.mjs";
      const helper = typescript ? "helper.ts" : mode === "require" ? "helper.cjs" : "helper.mjs";
      const specifier =
        dependency === "package" ? "computed-dependency" : `./${helper.replace(/\.ts$/, ".js")}`;
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "computed-dependency": "1.0.0" } }),
      );
      const packageRoot = path.join(root, "node_modules", "computed-dependency");
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ exports: { import: "./import.mjs", require: "./require.cjs" } }),
      );
      const write = (value: string) => {
        fs.writeFileSync(
          path.join(root, helper),
          typescript
            ? `enum Value { Current = ${JSON.stringify(value)} }; export const value = Value.Current;`
            : mode === "require"
              ? `exports.value = ${JSON.stringify(value)};`
              : `export const value = ${JSON.stringify(value)};`,
        );
        fs.writeFileSync(
          path.join(packageRoot, "require.cjs"),
          `exports.value = ${JSON.stringify(`require:${value}`)};`,
        );
        fs.writeFileSync(
          path.join(packageRoot, "import.mjs"),
          `export const value = ${JSON.stringify(`import:${value}`)};`,
        );
      };
      write("before");
      const read = mode === "require" ? "require(name).value" : "(await import(name)).value";
      fs.writeFileSync(
        path.join(root, entry),
        `${entry.endsWith("cjs") ? "exports.read =" : "export const read ="} ${mode === "import" ? "async " : ""}(name${typescript ? ": string" : ""}) => ${read};
         ${mode === "require" ? `${entry.endsWith("cjs") ? "exports.initial = exports.read" : "export const initial = read"}(${JSON.stringify(specifier)});` : ""}`,
      );
      const first = load(root, entry, true);
      const plugin = first.value as {
        initial?: string;
        read(name: string): string | Promise<string>;
      };
      const expected = (value: string) => (dependency === "package" ? `${mode}:${value}` : value);
      if (mode === "require") {
        expect(plugin.initial).toBe(expected("before"));
      }
      write("first-demand");
      const captured = mode === "require" ? "before" : "first-demand";
      expect(await plugin.read(specifier)).toBe(expected(captured));
      write("replacement");
      expect(await plugin.read(specifier)).toBe(expected(captured));
      const replacement = load(root, entry, true).value as typeof plugin;
      expect(await replacement.read(specifier)).toBe(expected("replacement"));
      if (dependency === "local") {
        const unrelated = path.join(root, "unrelated", "private.txt");
        fs.mkdirSync(path.dirname(unrelated));
        fs.writeFileSync(unrelated, "unrelated workspace data");
        await expect(Promise.resolve().then(() => plugin.read("./unrelated"))).rejects.toThrow();
        expect(first.instance.hasModuleSource(unrelated)).toBe(false);
      }
      await first.instance.dispose();
      expect(() => plugin.read("./not-previously-requested.js")).toThrow("reloaded or disabled");
    },
  );

  it.each(["ts", "mtsx", "ctsx"])(
    "compiles native filesystem path spelling for %s sources",
    (extension) => {
      const root = temp.make("plugin-native-path-");
      if (process.platform !== "win32") {
        const artifactTemp = path.join(temp.make("compiler-temporary-"), "artifact\\root");
        fs.mkdirSync(artifactTemp);
        vi.stubEnv("TMPDIR", artifactTemp);
      }
      const entry = `index.${extension}`;
      fs.writeFileSync(path.join(root, entry), "export const value: number = 42;");
      expect(load(root, entry).value).toMatchObject({ value: 42 });
    },
  );

  it.each([
    ...["ts", "js", "cjs"].flatMap((extension) =>
      ["auto", "explicit", "disabled-relative"].map((mode) => ({
        extension,
        mode,
        standalone: false,
      })),
    ),
    { extension: "ts", mode: "relative-config", standalone: false },
    { extension: "ts", mode: "auto", standalone: true },
    { extension: "ts", mode: "explicit", standalone: true },
    { extension: "ts", mode: "relative-config", standalone: true },
    { extension: "ts", mode: "extends", standalone: false },
    { extension: "ts", mode: "extends", standalone: true },
    ...["ancestor", "npm-extends"].flatMap((mode) =>
      [false, true].map((standalone) => ({ extension: "ts", mode, standalone })),
    ),
  ])(
    "preserves existing Jiti tsconfig paths startup ($extension/$mode, standalone: $standalone)",
    async ({ extension, mode, standalone }) => {
      const fixtureRoot = temp.make("plugin-tsconfig-paths-");
      const externalConfig = mode === "ancestor" || mode === "npm-extends";
      const root = externalConfig ? path.join(fixtureRoot, "plugin") : fixtureRoot;
      fs.mkdirSync(root, { recursive: true });
      const entry = `index.${extension}`;
      const source = path.join(root, entry);
      const tsconfig = path.join(mode === "ancestor" ? fixtureRoot : root, "tsconfig.json");
      fs.mkdirSync(path.join(root, "lib"));
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      const unused = path.join(root, "unused", "unrelated.ts");
      fs.mkdirSync(path.dirname(unused));
      fs.writeFileSync(unused, 'throw new Error("unrelated source must not execute");');
      fs.writeFileSync(
        path.join(root, "unused", "tsconfig.json"),
        JSON.stringify({ extends: "./not-installed.json" }),
      );
      const writeConfig = (directory: string) => {
        const inherited = mode === "extends" || mode === "npm-extends";
        const base =
          mode === "npm-extends"
            ? path.join(fixtureRoot, "node_modules", "fixture-config", "base.json")
            : path.join(root, "config", "base.json");
        if (inherited) {
          fs.mkdirSync(path.dirname(base), { recursive: true });
          fs.writeFileSync(
            tsconfig,
            JSON.stringify({
              extends: mode === "npm-extends" ? "fixture-config" : "./config/base.json",
            }),
          );
          if (mode === "npm-extends") {
            fs.writeFileSync(
              path.join(path.dirname(base), "package.json"),
              JSON.stringify({ name: "fixture-config", exports: "./base.json" }),
            );
          }
        }
        const configFile = inherited ? base : tsconfig;
        fs.writeFileSync(
          configFile,
          JSON.stringify({
            compilerOptions: {
              baseUrl: path.relative(path.dirname(configFile), root) || ".",
              paths: { "@fixture/*": [`${directory}/*`] },
            },
          }),
        );
      };
      const writeHelpers = (directory: string, value: string) => {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
        for (const name of ["helper", "lazy"]) {
          fs.writeFileSync(
            path.join(root, directory, `${name}.ts`),
            `export const value: string = ${JSON.stringify(value)};`,
          );
        }
      };
      writeConfig("lib");
      writeHelpers("lib", "ready");
      const specifier = (name: string) =>
        mode === "disabled-relative" ? `./lib/${name}.ts` : `@fixture/${name}`;
      const read = `read: () => import(${JSON.stringify(specifier("lazy"))}).then(module => module.value), missing: () => import("@fixture/not-installed")`;
      fs.writeFileSync(
        source,
        extension === "cjs"
          ? `const { value } = require(${JSON.stringify(specifier("helper"))}); exports.default = { value, ${read} };`
          : `import { value } from ${JSON.stringify(specifier("helper"))}; export default { value, ${read} };`,
      );
      vi.stubEnv(
        "JITI_TSCONFIG_PATHS",
        mode === "auto" || mode === "extends" || externalConfig
          ? "true"
          : mode === "explicit"
            ? tsconfig
            : mode === "relative-config"
              ? path.relative(process.cwd(), tsconfig)
              : "false",
      );
      const legacy = createJiti(source, {
        tryNative: false,
        fsCache: false,
        moduleCache: false,
        interopDefault: false,
      })(source) as {
        default: { value: string; read(): Promise<string>; missing(): Promise<unknown> };
      };
      expect(legacy.default.value).toBe("ready");
      expect(await legacy.default.read()).toBe("ready");
      const first = load(root, entry, standalone);
      const current = first.value as typeof legacy;
      expect(current.default.value).toBe("ready");
      expect(first.instance.hasModuleSource(unused)).toBe(!standalone);
      writeHelpers("lib", "edited");
      writeHelpers("replacement", "edited");
      writeConfig("replacement");
      expect(await current.default.read()).toBe("ready");
      const reloaded = load(root, entry, standalone).value as typeof legacy;
      expect(reloaded.default.value).toBe("edited");
      expect(await reloaded.default.read()).toBe("edited");
      expect(await current.default.read()).toBe("ready");
      await expect(current.default.missing()).rejects.toThrow("@fixture/not-installed");
      await first.instance.dispose();
      expect(() => current.default.read()).toThrow("reloaded or disabled");
    },
  );

  it.each(["before bind", "directory before bind", "after bind", "unchanged"])(
    "checks expected source bytes before execution and uses that same capture (%s)",
    async (change) => {
      const marker = path.join(temp.make("plugin-expected-effect-"), "ran");
      const entry = (value: string) =>
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(value)}); module.exports = ${JSON.stringify(value)};`;
      const root = temp.make("plugin-expected-source-");
      const source = path.join(root, "entry.cjs");
      fs.writeFileSync(source, entry("reviewed"));
      const prepared = capturePluginGenerationArtifact(root);
      const expectedSourceDigest = prepared.sourceDigest;
      prepared.dispose();
      const instance = new PluginInstance("fixture");
      instances.push(instance);
      const options = {
        instance,
        origin: "config" as const,
        source,
        rootDir: root,
        expectedSourceDigest,
      };
      if (change.endsWith("before bind")) {
        if (change === "directory before bind") {
          fs.mkdirSync(path.join(root, "empty"));
        } else {
          fs.writeFileSync(source, entry("changed"));
        }
        expect
          .soft(() => {
            bindPluginInstanceModuleLoader(options);
            instance.loadModule(source);
          })
          .toThrow(/source.*changed/i);
        expect(fs.existsSync(marker)).toBe(false);
      } else {
        bindPluginInstanceModuleLoader(options);
        if (change === "after bind") {
          fs.writeFileSync(source, entry("changed"));
        }
        expect(instance.loadModule(source)).toBe("reviewed");
        expect(fs.readFileSync(marker, "utf8")).toBe("reviewed");
      }
    },
  );

  it("retains native JSON import attributes for a computed JavaScript edge", async () => {
    const root = temp.make("plugin-native-computed-json-");
    fs.writeFileSync(path.join(root, "data.json"), '{"value":42}');
    fs.writeFileSync(
      path.join(root, "index.mjs"),
      "export const read = (name, attributes) => import(name, { with: attributes });",
    );
    const plugin = load(root, "index.mjs", true).value as {
      read(name: string, attributes?: { type: string }): Promise<unknown>;
    };
    await expect(plugin.read("./data.json")).rejects.toMatchObject({
      code: "ERR_IMPORT_ATTRIBUTE_MISSING",
    });
    await expect(plugin.read("./data.json", { type: "json" })).resolves.toMatchObject({
      default: { value: 42 },
    });
  });

  it.each([
    "static",
    "dynamic",
    "explicit",
    "commonjs",
    "commonjs-dynamic",
    "computed",
    "commonjs-computed",
  ])("preserves TypeScript JSON imports across generations (%s)", async (mode) => {
    const root = temp.make("plugin-json-generation-");
    const entry = mode.startsWith("commonjs") ? "index.cts" : "index.ts";
    const source = path.join(root, entry);
    const data = path.join(root, "data.json");
    const computed = mode.endsWith("computed");
    fs.writeFileSync(data, '{"value":"before"}');
    fs.writeFileSync(
      source,
      mode.endsWith("dynamic") || computed
        ? `const name = './data.json'; export const read = async () => (await import(${computed ? "name" : "'./data.json'"})).default.value;`
        : `import data from './data.json' ${mode === "explicit" ? "with { type: 'json' }" : ""};
             export const read = async () => data.value;`,
    );
    type JsonPlugin = { read(): Promise<string> };
    const legacy = createJiti(source, { fsCache: false, moduleCache: false })(source) as JsonPlugin;
    expect(await legacy.read()).toBe("before");
    const first = load(root, entry, computed).value as JsonPlugin;
    expect(await first.read()).toBe("before");
    fs.writeFileSync(data, '{"value":"after"}');
    const second = load(root, entry, computed).value as JsonPlugin;
    expect(await second.read()).toBe("after");
    expect(await first.read()).toBe("before");
  });

  it("preserves a TypeScript plugin default beside wildcard CommonJS reexports", () => {
    const root = temp.make("plugin-source-wildcard-");
    fs.writeFileSync(path.join(root, "dependency.cjs"), "exports.answer = 42;");
    fs.writeFileSync(
      path.join(root, "index.ts"),
      `export default { id: 'fixture' };
      export * from './dependency.cjs';`,
    );
    const value = load(root, "index.ts").value as { default: { id: string }; answer: number };
    expect(value.default.id).toBe("fixture");
    expect(value.answer).toBe(42);
  });

  it.each(["native", "explicit"] as const)(
    "retains %s module.exports interoperability without a TypeScript namespace override",
    (mode) => {
      const root = temp.make("plugin-native-module-exports-");
      const entry = mode === "native" ? "index.mjs" : "index.ts";
      fs.writeFileSync(path.join(root, "dependency.cjs"), "exports.answer = 42;");
      fs.writeFileSync(
        path.join(root, entry),
        mode === "native"
          ? "export default { id: 'ignored' }; export * from './dependency.cjs';"
          : "const value = { answer: 42 }; export { value as 'module.exports' }; export default { id: 'ignored' };",
      );
      const source = path.join(root, entry);
      const expected =
        mode === "native"
          ? nativeRequire(source)
          : createJiti(source, {
              tryNative: false,
              fsCache: false,
              moduleCache: false,
            })(source);
      expect(load(root, entry).value).toEqual(expected);
    },
  );

  it("defers unused TypeScript syntax errors until their module is loaded", async () => {
    const root = temp.make("plugin-lazy-source-error-");
    fs.writeFileSync(
      path.join(root, "index.ts"),
      "export const read = () => import('./broken.ts');",
    );
    fs.writeFileSync(path.join(root, "broken.ts"), "export const value: = 1;");
    const plugin = load(root, "index.ts").value as { read(): Promise<unknown> };
    await expect(plugin.read()).rejects.toThrow(
      /^broken\.ts\(1,21\): error TS1110: Type expected\./,
    );
  });

  it("loads TypeScript package main without parsing unused nested package metadata", () => {
    const root = temp.make("plugin-unused-package-metadata-");
    const dependency = path.join(root, "node_modules", "source-main");
    fs.mkdirSync(dependency, { recursive: true });
    fs.mkdirSync(path.join(root, "unused"));
    fs.writeFileSync(path.join(root, "unused", "package.json"), "{");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { "source-main": "1.0.0" } }),
    );
    fs.writeFileSync(path.join(dependency, "package.json"), '{"main":"./index.ts"}');
    fs.writeFileSync(
      path.join(dependency, "index.ts"),
      "enum Value { Current = 42 }; export const value = Value.Current;",
    );
    fs.writeFileSync(
      path.join(root, "index.ts"),
      "import { value } from 'source-main'; export const read = () => value;",
    );
    expect((load(root, "index.ts").value as { read(): number }).read()).toBe(42);
  });

  it.each(["tsx", "mtsx", "ctsx"] as const)(
    "honors existing Jiti JSX for %s and JSX helpers",
    (extension) => {
      vi.stubEnv("JITI_JSX", "1");
      const root = temp.make("plugin-jsx-source-");
      const entry = `index.${extension}`;
      fs.writeFileSync(
        path.join(root, "helper.jsx"),
        `const React = {
        createElement: (tag, props) => [tag, props.label]
      }; export const helper = <helper label="ready" />;`,
      );
      fs.writeFileSync(
        path.join(root, entry),
        `import { helper } from './helper.jsx';
        const React = { createElement: (tag: string, props: { label: string }) => [tag, props.label] };
        export const value = [<demo label="ready" />, helper];`,
      );
      expect((load(root, entry).value as { value: string[][] }).value).toEqual([
        ["demo", "ready"],
        ["helper", "ready"],
      ]);
    },
  );

  it("emits standard Node shims without changing lexical bindings", () => {
    const root = temp.make("plugin-source-bindings-");
    fs.writeFileSync(
      path.join(root, "index.ts"),
      `import path from 'node:path';
       declare const require: NodeRequire;
       declare const __filename: string;
       declare const __dirname: string;
       function local(require: (name: string) => number) { return require('local'); }
       const object = { require: () => 5 };
       export const read = () => [typeof require('node:fs').readFileSync,
         local(() => 3), object.require(), path.dirname(__filename) === __dirname,
         new URL(import.meta.url).pathname.endsWith('/index.ts')];`,
    );
    const source = path.join(root, "index.ts");
    const legacy = createJiti(source, { tryNative: false, fsCache: false, moduleCache: false })(
      source,
    ) as { read(): unknown[] };
    const expected = ["function", 3, 5, true, true];
    expect(legacy.read()).toEqual(expected);
    expect((load(root, "index.ts").value as typeof legacy).read()).toEqual(expected);
  });

  it("keeps declared source package imports and self exports in one emitted graph", async () => {
    const root = temp.make("plugin-source-exports-");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fixture-source",
        type: "module",
        exports: { "./state": "./state.ts" },
        imports: { "#state": "./state.ts" },
      }),
    );
    fs.writeFileSync(path.join(root, "state.ts"), "export const state = { count: 0 };");
    fs.writeFileSync(
      path.join(root, "index.ts"),
      `import { state } from '#state';
      export async function read() {
        const later = await import('fixture-source/state');
        state.count++; return [state === later.state, later.state.count];
      }`,
    );
    const first = load(root, "index.ts").value as { read(): Promise<unknown[]> };
    expect(await first.read()).toEqual([true, 1]);
    expect(await first.read()).toEqual([true, 2]);
    expect(await (load(root, "index.ts").value as typeof first).read()).toEqual([true, 1]);
  });

  it("preserves native custom loader startup without replaying registration", async () => {
    const root = temp.make("plugin-native-hooks-");
    fs.writeFileSync(
      path.join(root, "index.cjs"),
      `const { registerHooks } = require('node:module');
       const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
         return specifier === 'fixture:answer'
           ? { url: 'data:text/javascript,export default 42', shortCircuit: true }
           : nextResolve(specifier, context);
       }});
       exports.read = async () => (await import('fixture:answer')).default;
       exports.close = () => hooks.deregister();`,
    );
    const { instance, value } = load(root, "index.cjs");
    const plugin = value as { read(): Promise<number>; close(): void };
    try {
      expect(await plugin.read()).toBe(42);
    } finally {
      plugin.close();
      await instance.dispose();
    }
    expect(() => plugin.read()).toThrow("reloaded or disabled");
  });

  it.each(["cjs", "ts"])("does not reevaluate a failing module through a %s entry", (extension) => {
    const root = temp.make("plugin-failed-native-");
    const effect = path.join(root, "effect.txt");
    fs.writeFileSync(
      path.join(root, extension === "cjs" ? "index.cjs" : "failure.cjs"),
      `require('node:fs').appendFileSync(${JSON.stringify(effect)}, ${JSON.stringify("once\n")});
       require('./not-installed.cjs');`,
    );
    if (extension === "ts") {
      fs.writeFileSync(path.join(root, "index.ts"), "import './failure.cjs';");
    }
    expect(() => load(root, `index.${extension}`)).toThrow("not-installed.cjs");
    expect(fs.readFileSync(effect, "utf8")).toBe("once\n");
  });

  it.each(["ts", "tsx", "mts", "cts"] as const)(
    "reloads explicit TypeScript imports from edited %s source without changing native JS peers",
    async (extension) => {
      const root = temp.make("plugin-source-generation-");
      const emitted = extension === "mts" ? "mjs" : extension === "cts" ? "cjs" : "js";
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      fs.writeFileSync(
        path.join(root, `index.${extension}`),
        `import { value } from './helper.${extension}';
         export async function read() {
           const name = 'helper';
           return [value, (await import('./' + name + '.${extension}')).value];
         }`,
      );
      const helper = path.join(root, `helper.${extension}`);
      fs.writeFileSync(helper, "enum Value { Current = 1 }; export const value = Value.Current;");
      fs.writeFileSync(
        path.join(root, `helper.${emitted}`),
        emitted === "cjs" ? "exports.value = 0;" : "export const value = 0;",
      );
      fs.writeFileSync(
        path.join(root, "native.mjs"),
        `export { value } from './helper.${emitted}';`,
      );
      const source = path.join(root, `index.${extension}`);
      const legacy = createJiti(source, { tryNative: false, fsCache: false, moduleCache: false })(
        source,
      ) as { read(): Promise<number[]> };
      expect(await legacy.read()).toEqual([1, 1]);
      const first = load(root, `index.${extension}`);
      const a = first.value as typeof legacy;
      expect(await a.read()).toEqual([1, 1]);
      fs.writeFileSync(helper, "enum Value { Current = 2 }; export const value = Value.Current;");
      const b = load(root, `index.${extension}`).value as typeof a;
      expect(await b.read()).toEqual([2, 2]);
      expect(await a.read()).toEqual([1, 1]);
      expect((load(root, "native.mjs").value as { value: number }).value).toBe(0);
      await first.instance.dispose();
      expect(() => a.read()).toThrow("reloaded or disabled");
    },
  );
});
