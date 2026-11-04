import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStandaloneNativeAdapter } from "../../scripts/lib/bun-standalone-native.mjs";
import { createStandaloneRequireAdapter } from "../../scripts/lib/bun-standalone-require.mjs";
import {
  planStandaloneRuntime,
  pruneStandaloneRuntime,
} from "../../scripts/lib/bun-standalone-sidecar.mjs";
import { createStandaloneSourceEntries } from "../../scripts/lib/bun-standalone-source-entries.mjs";
import { createStandaloneSourceGraph } from "../../scripts/lib/bun-standalone-source-graph.mjs";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";

const parse = createStandaloneSourceParser();
const temporary: string[] = [];
afterEach(() =>
  temporary
    .splice(0)
    .forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })),
);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-native-"));
  temporary.push(root);
  function write(filename: string, contents = "fixture") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  function pkg(name: string, manifest: Record<string, unknown>, files: Record<string, string>) {
    const directory = path.join(
      root,
      "node_modules/.pnpm",
      `${name.replaceAll("/", "+")}@1.0.0`,
      "node_modules",
      name,
    );
    write(
      path.join(directory, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...manifest }),
    );
    for (const [filename, contents] of Object.entries(files)) {
      write(path.join(directory, filename), contents);
    }
    const link = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(directory, link);
    return directory;
  }
  return { root, write, pkg };
}

function evaluate(
  adapter: ReturnType<typeof createStandaloneNativeAdapter>,
  embeddedPaths: Record<string, string> = {},
  root = "/relocated/runtime",
) {
  const finalized = adapter.finalize({ embeddedPaths });
  const context = vm.createContext({ root, path, fileURLToPath });
  vm.runInContext(
    adapter.bootstrap
      .replace(/^import[^\n]+\n/, "")
      .replace(finalized.bootstrapReplacement.search, finalized.bootstrapReplacement.replacement),
    context,
  );
  return { finalized, context, root };
}

function hoistedCopies() {
  const { root, write } = fixture();
  const parents = [
    path.join(root, "node_modules", "first"),
    path.join(root, "node_modules", "second"),
  ] as const;
  const helpers = [
    path.join(parents[0], "node_modules", "helper"),
    path.join(parents[1], "node_modules", "helper"),
  ] as const;
  write(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { first: "1.0.0", second: "1.0.0" } }),
  );
  for (const parent of parents) {
    const helper = path.join(parent, "node_modules", "helper");
    write(
      path.join(parent, "package.json"),
      JSON.stringify({
        name: path.basename(parent),
        version: "1.0.0",
        dependencies: { helper: "1.0.0" },
      }),
    );
    write(path.join(parent, "index.js"), "module.exports = require('helper');");
    write(
      path.join(helper, "package.json"),
      JSON.stringify({ name: "helper", version: "1.0.0", main: "index.js" }),
    );
    write(path.join(helper, "LICENSE"), "Same license\n");
    write(path.join(helper, "index.js"), "module.exports = 1;");
  }
  const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
  for (const directory of [...parents, ...helpers]) {
    const filename = path.join(directory, "index.js");
    adapter.transform({ filename, contents: fs.readFileSync(filename, "utf8") });
  }
  return { root, write, parents, helpers, adapter };
}

describe("standalone native sidecar", () => {
  it("retains opaque parser dependencies from emitted companions excluded by source selection", () => {
    const { root, write, pkg } = fixture();
    write(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "openclaw",
        type: "module",
        dependencies: { "syntax-library": "1.0.0" },
      }),
    );
    const parser = pkg(
      "syntax-library",
      { main: "index.cjs" },
      { "index.cjs": "exports.parse = JSON.parse;" },
    );
    const source = `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export function parse(text) { return require("syntax-library").parse(text); }`;
    write(path.join(root, "src/scanner.ts"), source);
    write(path.join(root, "dist/scanner.js"), 'export { parse } from "./scanner-hash.mjs";');
    write(path.join(root, "dist/scanner-hash.mjs"), source);
    write(
      path.join(root, "disk-loader.cjs"),
      'const {createRequire} = require("node:module"); exports.load = createRequire(__filename); exports.platform = require("node:os").platform();',
    );
    const sources = createStandaloneSourceEntries({
      sourceRoot: root,
      configs: [{ entry: { scanner: "src/scanner.ts" }, fixedExtension: false }],
    });
    const native = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    const entries = native.discover(["dist/scanner.js", "dist/scanner-hash.mjs"], {
      selectRuntimeEntries: sources.selectRuntimeEntries,
      scanOnlyEntries: ["disk-loader.cjs"],
    });
    expect(entries).toEqual([
      "dist/scanner.js",
      path.relative(root, path.join(parser, "index.cjs")).split(path.sep).join("/"),
    ]);
    expect(native.builtinModules).toContain("node:os");
    fs.unlinkSync(path.join(root, "dist/scanner-hash.mjs"));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const {parse} = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/scanner.ts")).href)}); console.log(JSON.stringify(parse('{"type":"fixture"}')));`,
      ],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ type: "fixture" });
  });

  it("keeps native routing bytes stable across graph discovery order", () => {
    const { root, pkg } = fixture();
    const entries = ["@fixture/alpha", "@fixture/bravo"].map((name) =>
      path.join(
        pkg(
          name,
          { type: "module", main: "index.js" },
          { "index.js": "export const value = 1;", "runtime.wasm": "synthetic resource" },
        ),
        "index.js",
      ),
    );
    const capture = (filenames: string[]) =>
      createStandaloneNativeAdapter({ runtimeRoot: root, parse }).finalize({
        metafile: { inputs: Object.fromEntries(filenames.map((filename) => [filename, {}])) },
      });
    const first = capture(entries);
    const reversed = capture(entries.toReversed());
    expect(first.files.filter((file) => file.source.endsWith("runtime.wasm"))).toHaveLength(2);
    expect(
      reversed.files.map((file) => file.source).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(first.files.map((file) => file.source).toSorted((a, b) => a.localeCompare(b)));
    expect(reversed.bootstrapReplacement.replacement).toBe(first.bootstrapReplacement.replacement);
  });

  it("loads admitted addons through the native boundary and preserves the module cache", () => {
    const { root, write, pkg } = fixture();
    const addon = pkg("addon", { main: "binding.node" }, { "binding.node": "native fixture" });
    write(path.join(root, "package.json"), JSON.stringify({ dependencies: { addon: "1" } }));
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    adapter.transform({ filename: path.join(addon, "binding.node"), contents: "" });
    const relocated = path.join(root, "relocated");
    const { context } = evaluate(adapter, {}, relocated);
    const binding = { value: 42 };
    const failure = new Error("native initialization failed");
    const dlopen = vi
      .fn((module: { exports: unknown }) => {
        module.exports = binding;
      })
      .mockImplementationOnce(() => {
        throw failure;
      });
    Object.assign(context, {
      commonJsEntries: new Set(),
      embedded: () => undefined,
      process: { dlopen },
    });
    const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths: {} });
    vm.runInContext(requireAdapter.bootstrap, context);
    const load = context["__openclawStandaloneCreateRequire"](
      createRequire,
      path.join(relocated, "entry.mjs"),
    );
    const filename = load.resolve("addon");
    try {
      expect(() => load("addon")).toThrow(failure);
      expect(load.cache[filename]).toBeUndefined();
      expect(load("addon")).toBe(binding);
      expect(load(filename)).toBe(binding);
      expect(dlopen).toHaveBeenCalledTimes(2);
      expect(load.cache[filename]).toMatchObject({ filename, loaded: true, exports: binding });
      delete load.cache[filename];
      expect(load("addon")).toBe(binding);
      expect(dlopen).toHaveBeenCalledTimes(3);
      const outside = path.join(root, "outside.node");
      write(outside, "not an admitted addon");
      expect(() => load(outside)).toThrow();
      expect(dlopen).toHaveBeenCalledTimes(3);
    } finally {
      delete load.cache[filename];
    }
  });

  it("skips file probes for discarded text while retaining resource payloads", () => {
    const { root, write, pkg } = fixture();
    const discarded = [
      "index.js",
      "types.d.ts",
      "index.js.map",
      "data.json",
      "README.md",
      "run.sh",
    ];
    const owner = pkg(
      "resource-fixture",
      {},
      {
        ...Object.fromEntries(discarded.map((name) => [name, "discarded"])),
        "archive.wasm": "wasm payload",
        "bin/helper": "executable payload",
        "unused.dat": "unused payload",
      },
    );
    fs.chmodSync(path.join(owner, "bin/helper"), 0o755);
    fs.chmodSync(path.join(owner, "run.sh"), 0o755);
    const playwright = pkg(
      "playwright-core",
      {},
      { "browsers.json": "{}", "lib/vite/app.js": "browser payload" },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "resource-fixture": "1", "playwright-core": "1" } }),
    );
    const discardedPaths = new Set(discarded.map((name) => path.join(owner, name)));
    const realpath = vi.spyOn(fs, "realpathSync");
    const stat = vi.spyOn(fs, "statSync");
    let adapter: ReturnType<typeof createStandaloneNativeAdapter>;
    try {
      adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
      expect(
        realpath.mock.calls.filter(([filename]) => discardedPaths.has(String(filename))),
      ).toHaveLength(0);
      expect(
        stat.mock.calls.filter(([filename]) => discardedPaths.has(String(filename))),
      ).toHaveLength(0);
      expect(stat).toHaveBeenCalledWith(path.join(owner, "bin/helper"));
      expect(stat).toHaveBeenCalledWith(path.join(owner, "unused.dat"));
    } finally {
      realpath.mockRestore();
      stat.mockRestore();
    }
    for (const directory of [owner, playwright]) {
      adapter.transform({ filename: path.join(directory, "index.js"), contents: "export {};" });
    }
    const resources = adapter
      .finalize()
      .files.filter((file) => file.category !== "dependencyMetadata");
    expect(
      resources.map((file) => file.source).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(
      [
        path.join(owner, "archive.wasm"),
        path.join(owner, "bin/helper"),
        path.join(playwright, "browsers.json"),
        path.join(playwright, "lib/vite/app.js"),
      ]
        .map((filename) => path.relative(root, filename))
        .toSorted(),
    );
    expect(
      resources.map((file) => fs.readFileSync(path.join(root, file.source), "utf8")).toSorted(),
    ).toEqual(["wasm payload", "executable payload", "{}", "browser payload"].toSorted());
  });

  it.each(["entry.js", "binding.node"])("rejects an escaping file symlink named %s", (name) => {
    const { root, write, pkg } = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-native-outside-"));
    temporary.push(outside);
    write(path.join(outside, name), "outside payload");
    const owner = pkg("escaping-resource", {}, {});
    const link = path.join(owner, name);
    fs.symlinkSync(path.join(outside, name), link);
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "escaping-resource": "1" } }),
    );
    expect(() => createStandaloneNativeAdapter({ runtimeRoot: root, parse })).toThrow(
      `Dependency resource escapes runtime: ${link}`,
    );
  });

  it("collapses identical hoisted metadata and licenses while retaining every resolution path", () => {
    const { root, parents, helpers, adapter } = hoistedCopies();
    const { finalized, context } = evaluate(adapter, {}, root);
    const shared = path.join(root, "native/helper@1.0.0/helper");
    expect(
      finalized.files.filter((file) => file.destination.startsWith("native/helper@1.0.0/")),
    ).toHaveLength(2);
    pruneStandaloneRuntime(planStandaloneRuntime(root, finalized.files));
    for (const name of ["package.json", "LICENSE"]) {
      const expected = path.join(shared, name);
      const resource = finalized.files.find(
        (file) => path.join(root, file.destination) === expected,
      );
      expect(resource?.sources).toEqual(
        helpers.map((helper) => `${path.relative(root, helper).split(path.sep).join("/")}/${name}`),
      );
      for (const parent of parents) {
        expect(
          context["__openclawStandaloneNativeResolve"](
            path.join(parent, "index.js"),
            `helper/${name}`,
          ),
        ).toBe(expected);
      }
      for (const parent of [...helpers, shared]) {
        expect(
          context["__openclawStandaloneNativeResolve"](path.join(parent, "index.js"), `./${name}`),
        ).toBe(expected);
      }
      expect(fs.readFileSync(expected, "utf8")).toContain(
        name === "LICENSE" ? "Same license" : '"name":"helper"',
      );
    }
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
  });

  it("preserves named package scopes and their resources under the installed package", () => {
    const { root, write, pkg } = fixture();
    const name = "@fixture/scoped";
    const scopes = [
      { directory: "dist/esm", type: "module" },
      { directory: "dist/commonjs", type: "commonjs" },
    ];
    const owner = pkg(
      name,
      { exports: { "./package.json": "./package.json" } },
      { "shared.wasm": "shared resource", LICENSE: "scope fixture license" },
    );
    write(path.join(root, "package.json"), JSON.stringify({ dependencies: { [name]: "1.0.0" } }));
    for (const scope of scopes) {
      write(
        path.join(owner, scope.directory, "package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          type: scope.type,
          exports: { "./package.json": "./package.json" },
        }),
      );
      write(path.join(owner, scope.directory, "index.js"), "export {};");
      write(path.join(owner, scope.directory, "scope.wasm"), scope.type);
    }
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    const finalized = adapter.finalize({
      metafile: {
        inputs: Object.fromEntries(
          scopes.map((scope) => [path.join(owner, scope.directory, "index.js"), {}]),
        ),
      },
    });
    const context = vm.createContext({ root, path, fileURLToPath });
    vm.runInContext(
      adapter.bootstrap
        .replace(/^import[^\n]+\n/, "")
        .replace(finalized.bootstrapReplacement.search, finalized.bootstrapReplacement.replacement),
      context,
    );
    pruneStandaloneRuntime(planStandaloneRuntime(root, finalized.files));
    const destination = path.join(root, "native/@fixture+scoped@1.0.0/@fixture/scoped");
    expect(JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8"))).toEqual({
      name,
      version: "1.0.0",
      exports: { "./package.json": "./package.json" },
    });
    expect(fs.readFileSync(path.join(destination, "shared.wasm"), "utf8")).toBe("shared resource");
    expect(fs.readFileSync(path.join(destination, "LICENSE"), "utf8")).toBe(
      "scope fixture license",
    );
    for (const scope of scopes) {
      const originalEntry = path.join(owner, scope.directory, "index.js");
      const relocatedEntry = path.join(destination, scope.directory, "index.js");
      const manifest = path.join(destination, scope.directory, "package.json");
      expect(JSON.parse(fs.readFileSync(manifest, "utf8")).type).toBe(scope.type);
      expect(context["__openclawStandaloneNativeResolve"](originalEntry, "./package.json")).toBe(
        manifest,
      );
      expect(context["__openclawStandaloneOriginalPath"](relocatedEntry)).toBe(originalEntry);
      const resource = context["__openclawStandaloneNativeResolve"](relocatedEntry, "./scope.wasm");
      expect(resource).toBe(path.join(destination, scope.directory, "scope.wasm"));
      expect(fs.readFileSync(resource, "utf8")).toBe(scope.type);
    }
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
  });

  it.each(["package.json", "LICENSE"])("rejects conflicting hoisted %s before pruning", (name) => {
    const { root, write, helpers, adapter } = hoistedCopies();
    write(
      path.join(helpers[1], name),
      name === "LICENSE"
        ? "Different license\n"
        : JSON.stringify({ name: "helper", version: "1.0.0", main: "index.js", changed: true }),
    );
    expect(() => adapter.finalize()).toThrow(
      `Conflicting standalone resource native/helper@1.0.0/helper/${name}: node_modules/first/node_modules/helper/${name} and node_modules/second/node_modules/helper/${name}`,
    );
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(true);
    expect(fs.existsSync(path.join(root, "native"))).toBe(false);
  });

  it("loads the full ws implementation through a transformed ESM caller after pruning", () => {
    const { root, write, pkg } = fixture();
    const dependency = pkg(
      "ws",
      {
        main: "index.js",
        exports: {
          ".": { require: "./index.js", default: "./index.js" },
          "./package.json": "./package.json",
        },
      },
      {
        "index.js": "module.exports = require('./lib/websocket.js');",
        "lib/websocket.js": "module.exports = { marker: 'full-ws' };",
      },
    );
    write(path.join(root, "package.json"), JSON.stringify({ dependencies: { ws: "1.0.0" } }));
    const image = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-image-"));
    temporary.push(image);
    const runner = path.join(image, "runner.mjs");
    write(
      runner,
      String.raw`
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createStandaloneNativeAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/bun-standalone-native.mjs")).href)};
import { createStandaloneRequireAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/bun-standalone-require.mjs")).href)};
import { rewriteStandaloneImports } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/bun-standalone-imports.mjs")).href)};
import { planStandaloneRuntime, pruneStandaloneRuntime } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/bun-standalone-sidecar.mjs")).href)};
import { createStandaloneSourceParser } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/bun-standalone-source-parser.mjs")).href)};
const parse = createStandaloneSourceParser();
const root = ${JSON.stringify(root)};
const image = ${JSON.stringify(image)};
const dependency = ${JSON.stringify(dependency)};
const filename = path.join(root, "dist/websocket.mjs");
const library = path.join(dependency, "lib/websocket.js");
const imageLibrary = path.join(image, "websocket.cjs");
fs.copyFileSync(library, imageLibrary);
const embeddedPaths = { [path.relative(root, library)]: imageLibrary };
const native = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
native.transform({ filename: library, contents: fs.readFileSync(library, "utf8") });
const source = 'import { createRequire } from "node:module"; import path from "node:path"; const require = createRequire(import.meta.url); const root = path.dirname(require.resolve("ws/package.json")); export const filename = require.resolve(path.join(root, "lib/websocket.js")); export const marker = require(filename).marker;';
fs.mkdirSync(path.dirname(filename), { recursive: true });
const transformed = rewriteStandaloneImports({ contents: native.transform({ filename, contents: source }).contents, filename, runtimeRoot: root, embeddedPaths, moduleAliases: {}, workerThreadsShim: "", parse });
const finalized = native.finalize({ embeddedPaths });
const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths });
const bootstrap = [
  'import path from "node:path";',
  'import { fileURLToPath, pathToFileURL } from "node:url";',
  'const root = ' + JSON.stringify(root) + ';',
  'globalThis.__openclawStandaloneRootUrl = pathToFileURL(root + "/").href;',
  'const entries = ' + JSON.stringify(embeddedPaths) + ';',
  'const commonJsEntries = new Set();',
  'function embedded(filename) { filename = globalThis.__openclawStandaloneOriginalPath?.(filename) ?? filename; return Object.values(entries).includes(filename) ? filename : entries[path.relative(root, filename)]; }',
  native.bootstrap.replace(finalized.bootstrapReplacement.search, finalized.bootstrapReplacement.replacement),
  requireAdapter.bootstrap,
].join("\n");
const bootstrapFile = path.join(image, "bootstrap.mjs");
const moduleFile = path.join(image, "caller.mjs");
fs.writeFileSync(bootstrapFile, bootstrap);
fs.writeFileSync(moduleFile, transformed);
pruneStandaloneRuntime(planStandaloneRuntime(root, finalized.files));
if (fs.existsSync(path.join(root, "node_modules"))) throw new Error("node_modules remains");
await import(pathToFileURL(bootstrapFile).href);
const loaded = await import(pathToFileURL(moduleFile).href);
if (loaded.filename !== library) throw new Error("require.resolve did not preserve the runtime filename");
if (loaded.marker !== "full-ws") throw new Error("loaded the wrong ws implementation");
console.log("full-ws loaded without node_modules");
`,
    );
    const result = spawnSync(
      process.env.OPENCLAW_STANDALONE_TEST_RUNTIME ?? process.execPath,
      [runner],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("full-ws loaded without node_modules");
  });

  it("keeps canonical native and CommonJS owners across typed dependency contexts", () => {
    const runtime = fixture();
    const source = fixture();
    for (const tree of [runtime, source]) {
      tree.pkg(
        "@fixture/fs-safe-native",
        { main: "binding.node" },
        { "binding.node": "native marker" },
      );
      tree.pkg(
        "@fixture/fs-safe",
        { optionalDependencies: { "@fixture/fs-safe-native": "1.0.0" } },
        { "dist/native.js": "export const url = import.meta.url;" },
      );
      tree.pkg(
        "ws",
        { main: "index.js", exports: { ".": "./index.js", "./package.json": "./package.json" } },
        {
          "index.js": "module.exports = require('./lib/websocket.js');",
          "lib/websocket.js": "module.exports = { marker: 'full-ws' };",
        },
      );
      tree.write(
        path.join(tree.root, "package.json"),
        JSON.stringify({ dependencies: { "@fixture/fs-safe": "1.0.0", ws: "1.0.0" } }),
      );
    }
    source.write(path.join(source.root, "src/entry.ts"), "export const value: number = 1;");
    const configs: Parameters<typeof createStandaloneSourceEntries>[0]["configs"] = [
      { entry: { first: "src/entry.ts" } },
      { entry: { second: "src/entry.ts" } },
    ];
    const embeddedPaths: Record<string, string> = {};
    const graph = createStandaloneSourceGraph({
      sourceRoot: source.root,
      runtimeRoot: runtime.root,
      outputRoot: path.dirname(runtime.root),
      sourceEntries: createStandaloneSourceEntries({ sourceRoot: source.root, configs }),
      embeddedPaths,
    });
    const parents = configs.map((config) =>
      graph.addSource(path.join(source.root, "src/entry.ts"), config),
    );
    const sourceWrapper = path.join(source.root, "node_modules/@fixture/fs-safe/dist/native.js");
    const sourceWs = path.join(source.root, "node_modules/ws/lib/websocket.js");
    const staged = configs.flatMap((config) =>
      [sourceWrapper, sourceWs].map((filename) => graph.materialize(filename, config)),
    );
    const nativeFilename = (filename: string) => {
      const file = graph.files.get(filename);
      return file?.relative.startsWith("node_modules/")
        ? path.join(runtime.root, file.relative)
        : filename;
    };
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: runtime.root, parse });
    for (const filename of staged) {
      adapter.transform({
        filename: nativeFilename(filename),
        contents: fs.readFileSync(filename, "utf8"),
      });
    }
    const image = fixture();
    const imageEntry = path.join(image.root, "websocket.cjs");
    image.write(imageEntry, "module.exports = { marker: 'full-ws' };");
    const canonicalWs = fs.realpathSync(
      path.join(runtime.root, "node_modules/ws/lib/websocket.js"),
    );
    embeddedPaths[path.relative(runtime.root, canonicalWs)] = imageEntry;
    const finalized = adapter.finalize({
      metafile: { inputs: Object.fromEntries(staged.map((filename) => [filename, {}])) },
      embeddedPaths,
      resolveFilename: nativeFilename,
    });
    const context = vm.createContext({
      root: runtime.root,
      path,
      fileURLToPath,
      createRequire,
      commonJsEntries: new Set(),
      embedded: (filename: string) => {
        const original = context["__openclawStandaloneOriginalPath"](filename);
        return original === imageEntry
          ? imageEntry
          : embeddedPaths[path.relative(runtime.root, original)];
      },
    });
    vm.runInContext(
      adapter.bootstrap
        .replace(/^import[^\n]+\n/, "")
        .replace(finalized.bootstrapReplacement.search, finalized.bootstrapReplacement.replacement),
      context,
    );
    vm.runInContext(
      createStandaloneRequireAdapter({ runtimeRoot: runtime.root, embeddedPaths }).bootstrap,
      context,
    );
    pruneStandaloneRuntime(planStandaloneRuntime(runtime.root, finalized.files));
    const nativeParent = path.join(
      runtime.root,
      "native/@fixture+fs-safe@1.0.0/@fixture/fs-safe/dist/native.js",
    );
    const expectedNative = path.join(
      runtime.root,
      "native/@fixture+fs-safe-native@1.0.0/@fixture/fs-safe-native/binding.node",
    );
    expect(
      context["__openclawStandaloneNativeResolve"](nativeParent, "@fixture/fs-safe-native"),
    ).toBe(expectedNative);
    expect(fs.readFileSync(expectedNative, "utf8")).toBe("native marker");
    for (const parent of parents) {
      const load = context["__openclawStandaloneCreateRequire"](createRequire, parent);
      expect(load("ws/lib/websocket.js").marker).toBe("full-ws");
    }
    expect(fs.existsSync(path.join(runtime.root, "node_modules"))).toBe(false);
    expect(staged.every((filename) => !fs.existsSync(filename))).toBe(true);
    expect(graph.contexts.size).toBe(2);
  });

  it("resolves graph-retained root and peer packages without retaining unused development packages", () => {
    const { root, write, pkg } = fixture();
    const first = pkg("hoisted", { main: "index.js" }, { "index.js": "module.exports = 'first';" });
    const second = path.join(root, "node_modules/.pnpm/hoisted@2.0.0/node_modules/hoisted");
    write(
      path.join(second, "package.json"),
      JSON.stringify({ name: "hoisted", version: "2.0.0", main: "index.js" }),
    );
    write(path.join(second, "index.js"), "module.exports = 'second';");
    fs.unlinkSync(path.join(root, "node_modules/hoisted"));
    fs.symlinkSync(second, path.join(root, "node_modules/hoisted"));
    const consumer = pkg(
      "peer-consumer",
      { peerDependencies: { hoisted: "*" } },
      { "index.js": "module.exports = {};" },
    );
    fs.mkdirSync(path.join(consumer, "node_modules"));
    fs.symlinkSync(first, path.join(consumer, "node_modules/hoisted"));
    pkg("unused-development", { main: "binding.node" }, { "binding.node": "unused" });
    write(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { "peer-consumer": "1.0.0" },
        devDependencies: { hoisted: "2.0.0", "unused-development": "1.0.0" },
      }),
    );
    const image = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-image-"));
    temporary.push(image);
    const embeddedPaths: Record<string, string> = {};
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    for (const [name, directory] of Object.entries({ first, second, consumer })) {
      const filename = path.join(directory, "index.js");
      const contents = fs.readFileSync(filename, "utf8");
      adapter.transform({ filename, contents });
      const imageEntry = path.join(image, `${name}.cjs`);
      fs.writeFileSync(imageEntry, contents);
      embeddedPaths[path.relative(root, filename)] = imageEntry;
    }
    const { context, finalized } = evaluate(adapter, embeddedPaths, root);
    const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths });
    Object.assign(context, {
      commonJsEntries: new Set(),
      embedded: (filename: string) =>
        Object.values(embeddedPaths).includes(filename)
          ? filename
          : embeddedPaths[path.relative(root, filename)],
    });
    vm.runInContext(requireAdapter.bootstrap, context);
    pruneStandaloneRuntime(planStandaloneRuntime(root, finalized.files));
    const fromRoot = context["__openclawStandaloneCreateRequire"](
      createRequire,
      path.join(root, "dist/entry.mjs"),
    );
    const fromPeer = context["__openclawStandaloneCreateRequire"](
      createRequire,
      path.join(root, "native/peer-consumer@1.0.0/peer-consumer/index.js"),
    );
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
    expect(fromRoot("hoisted/package.json").version).toBe("2.0.0");
    expect(fromRoot.resolve("hoisted")).toBe(path.join(second, "index.js"));
    expect(fromRoot("hoisted")).toBe("second");
    expect(fromPeer("hoisted/package.json").version).toBe("1.0.0");
    expect(fromPeer.resolve("hoisted")).toBe(path.join(first, "index.js"));
    expect(fromPeer("hoisted")).toBe("first");
    expect(
      finalized.files.some((file: { source: string }) =>
        file.source.includes("unused-development"),
      ),
    ).toBe(false);
  });

  it("keeps unloaded plugins' declared dependency metadata without promoting runtime payloads", () => {
    const { root, write, pkg } = fixture();
    const first = pkg(
      "declared",
      { main: "index.js" },
      {
        "index.js": "module.exports = 'first';",
        "native.node": "unused-native",
      },
    );
    const second = path.join(root, "node_modules/.pnpm/declared@2.0.0/node_modules/declared");
    write(
      path.join(second, "package.json"),
      JSON.stringify({ name: "declared", version: "2.0.0", main: "index.js" }),
    );
    write(path.join(second, "index.js"), "module.exports = 'second';");
    fs.unlinkSync(path.join(root, "node_modules/declared"));
    fs.symlinkSync(second, path.join(root, "node_modules/declared"));
    pkg("optional", { main: "index.js" }, { "index.js": "module.exports = 'optional';" });
    pkg(
      "unrelated",
      { main: "index.js" },
      { "index.js": "unused", "native.node": "unused-native" },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", devDependencies: { unrelated: "1" } }),
    );
    const pluginA = path.join(root, "dist/extensions/a");
    const pluginB = path.join(root, "dist/extensions/b");
    write(
      path.join(pluginA, "package.json"),
      JSON.stringify({
        name: "@openclaw/a",
        dependencies: { declared: "1" },
        optionalDependencies: { optional: "1", missing: "1" },
      }),
    );
    write(
      path.join(pluginB, "package.json"),
      JSON.stringify({ name: "@openclaw/b", dependencies: { declared: "2" } }),
    );
    fs.mkdirSync(path.join(pluginA, "node_modules"));
    fs.symlinkSync(first, path.join(pluginA, "node_modules/declared"));
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    const { context, finalized } = evaluate(adapter, {}, root);
    const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths: {} });
    Object.assign(context, { embedded: () => undefined, commonJsEntries: new Set() });
    vm.runInContext(requireAdapter.bootstrap, context);
    pruneStandaloneRuntime(planStandaloneRuntime(root, finalized.files));
    const fromA = context["__openclawStandaloneCreateRequire"](
      createRequire,
      path.join(pluginA, "index.js"),
    );
    const fromB = context["__openclawStandaloneCreateRequire"](
      createRequire,
      path.join(pluginB, "index.js"),
    );
    expect(fromA("declared/package.json").version).toBe("1.0.0");
    expect(fromB("declared/package.json").version).toBe("2.0.0");
    expect(fromA("optional/package.json").name).toBe("optional");
    expect(() => fromA.resolve("missing/package.json")).toThrow();
    expect(() => fromA("declared")).toThrow();
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
    expect(
      finalized.files.map((file: { destination: string }) => file.destination).toSorted(),
    ).toEqual([
      "native/declared@1.0.0/declared/package.json",
      "native/declared@2.0.0/declared/package.json",
      "native/optional@1.0.0/optional/package.json",
    ]);
  });

  it("loads exported package subpaths from the image after removing node_modules", () => {
    const { root, write, pkg } = fixture();
    const dependency = pkg(
      "@fixture/fs-safe",
      { exports: { "./secure-temp-root": "./dist/secure-temp-dir.js" } },
      { "dist/secure-temp-dir.js": "module.exports = { resolveSecureTempRoot: () => 'safe' };" },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "@fixture/fs-safe": "1.0.0" } }),
    );
    const image = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-image-"));
    temporary.push(image);
    const imageEntry = path.join(image, "secure-temp-dir.cjs");
    fs.copyFileSync(path.join(dependency, "dist/secure-temp-dir.js"), imageEntry);
    const sourceEntry = path.relative(root, path.join(dependency, "dist/secure-temp-dir.js"));
    const embeddedPaths = { [sourceEntry]: imageEntry };
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    const finalized = adapter.finalize({ embeddedPaths });
    const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths });
    const context = vm.createContext({
      root,
      path,
      fileURLToPath,
      createRequire,
      commonJsEntries: new Set(),
      embedded: (filename: string) =>
        filename === imageEntry ? imageEntry : embeddedPaths[path.relative(root, filename)],
    });
    vm.runInContext(
      adapter.bootstrap
        .replace(/^import[^\n]+\n/, "")
        .replace(finalized.bootstrapReplacement.search, finalized.bootstrapReplacement.replacement),
      context,
    );
    vm.runInContext(requireAdapter.bootstrap, context);
    pruneStandaloneRuntime(planStandaloneRuntime(root, finalized.files));
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
    const load = context["__openclawStandaloneCreateRequire"](
      createRequire,
      path.join(root, "dist/entry.mjs"),
    );
    expect(load("@fixture/fs-safe/secure-temp-root").resolveSecureTempRoot()).toBe("safe");
  });

  it("discovers opaque bundled requires without promoting metadata-only or shadowed packages", () => {
    const { root, write, pkg } = fixture();
    const native = pkg("native-helper", { main: "binding.node" }, { "binding.node": "native" });
    const library = pkg(
      "runtime-library",
      { main: "index.js" },
      { "index.js": "module.exports = 'embedded';" },
    );
    const esmLibrary = pkg(
      "esm-library",
      { main: "index.mjs", type: "commonjs" },
      { "index.mjs": "export default 'default-value'; export const named = 'named-value';" },
    );
    const childCli = pkg("child-cli", { main: "cli.js" }, { "cli.js": "process.exit(0);" });
    pkg("metadata-only", { main: "binding.node" }, { "binding.node": "metadata-only" });
    pkg("shadowed", { main: "binding.node" }, { "binding.node": "shadowed" });
    write(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    const plugin = path.join(root, "dist/extensions/example");
    write(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "example-plugin",
        dependencies: { "runtime-library": "1", "esm-library": "1", "child-cli": "1" },
        optionalDependencies: { "native-helper": "1", "metadata-only": "1", shadowed: "1" },
      }),
    );
    const helper = path.join(plugin, ".setup/runtime.mjs");
    write(
      helper,
      'import { createRequire as factory } from "node:module"; const load = (() => factory(import.meta.url))(); export { load as r };',
    );
    const entry = path.join(plugin, ".setup/chunk.mjs");
    write(
      entry,
      `import { r as load } from "./runtime.mjs";
      export const library = load("runtime-library");
      export const esmLibrary = load("esm-library");
      export const childCli = load.resolve("child-cli");
      export const native = load.resolve("native-helper");
      export const metadata = load("metadata-only/package.json");
      export const shadowed = (load) => load("shadowed");`,
    );
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    adapter.discover([path.relative(root, entry)]);
    expect(adapter.additionalModuleEntries).toContain(
      path.relative(root, path.join(library, "index.js")),
    );
    expect(adapter.commonJsEntries).toContain(path.relative(root, path.join(library, "index.js")));
    expect(adapter.additionalModuleEntries).not.toContain(
      path.relative(root, path.join(childCli, "cli.js")),
    );
    const image = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-image-"));
    temporary.push(image);
    const imageEntry = path.join(image, "library.cjs");
    const esmImageEntry = path.join(image, "esm-library.mjs");
    fs.copyFileSync(path.join(library, "index.js"), imageEntry);
    fs.copyFileSync(path.join(esmLibrary, "index.mjs"), esmImageEntry);
    const embeddedPaths = {
      [path.relative(root, path.join(library, "index.js"))]: imageEntry,
      [path.relative(root, path.join(esmLibrary, "index.mjs"))]: esmImageEntry,
    };
    const { context, finalized } = evaluate(adapter, embeddedPaths, root);
    Object.assign(context, {
      commonJsEntries: new Set(
        adapter.commonJsEntries.map((moduleEntry) => embeddedPaths[moduleEntry]),
      ),
      embedded: (filename: string) => embeddedPaths[path.relative(root, filename)],
    });
    vm.runInContext(
      createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths }).bootstrap,
      context,
    );
    pruneStandaloneRuntime(planStandaloneRuntime(root, finalized.files));
    const load = context["__openclawStandaloneCreateRequire"](createRequire, helper);
    expect(load("runtime-library")).toBe("embedded");
    expect(load("esm-library")).toMatchObject({ default: "default-value", named: "named-value" });
    expect(load("metadata-only/package.json").name).toBe("metadata-only");
    const nativePath = load.resolve("native-helper");
    expect(fs.readFileSync(nativePath, "utf8")).toBe("native");
    expect(nativePath).toBe(
      path.join(root, "native/native-helper@1.0.0/native-helper/binding.node"),
    );
    expect(
      finalized.files
        .filter((file: { category: string }) => file.category === "nativeAddons")
        .map((file: { source: string }) => file.source),
    ).toEqual([path.relative(root, path.join(native, "binding.node"))]);
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
  });

  it("retains native resources when the output parent is a symlink", () => {
    const { root, write, pkg } = fixture();
    const owner = pkg(
      "native-library",
      { main: "index.js" },
      {
        "index.js": "export const url = import.meta.url;",
        "binding.node": "native",
      },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "native-library": "1" } }),
    );
    const alias = `${root}-alias`;
    fs.symlinkSync(root, alias);
    temporary.push(alias);
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: alias, parse });
    adapter.transform({
      filename: path.join(alias, path.relative(root, owner), "index.js"),
      contents: "export const url = import.meta.url;",
    });
    const files = adapter.finalize().files;
    expect(
      files.some((file: { destination: string }) => file.destination.endsWith("/binding.node")),
    ).toBe(true);
    expect(files.every((file: { source: string }) => !file.source.startsWith("../"))).toBe(true);
  });

  it("routes literal package names resolving to addons through the physical sidecar", () => {
    const { root, write, pkg } = fixture();
    pkg("native-helper", { main: "binding.node" }, { "binding.node": "native" });
    const source = '(require) => require("native-helper")';
    const owner = pkg(
      "native-wrapper",
      { dependencies: { "native-helper": "1.0.0" } },
      { "index.js": "module.exports = require('native-helper');" },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "native-wrapper": "1.0.0" } }),
    );
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    const filename = path.join(owner, "index.js");
    const transformed = adapter.transform({ filename, contents: '() => require("native-helper")' });
    const { context } = evaluate(adapter);
    context["__openclawStandaloneRootUrl"] = "file:///relocated/runtime/";
    context["__openclawStandaloneNativeRequire"] = (parent: string, specifier: string) =>
      context["__openclawStandaloneNativeResolve"](parent, specifier);
    const load = vm.runInContext(transformed.contents, context);
    expect(load()).toBe("/relocated/runtime/native/native-helper@1.0.0/native-helper/binding.node");
    expect(adapter.transform({ filename, contents: source }).contents).toBe(source);
  });

  it("loads JavaScript behind a native-looking request and preserves native resource resolution", () => {
    const { root, write, pkg } = fixture();
    const owner = pkg(
      "native-looking-name",
      { main: "index.js" },
      {
        "index.js": "module.exports = require('./platform.node');",
        "platform.node.js": "module.exports = 'JavaScript platform';",
        "binding.node": "native fixture",
        "module.wasm": "wasm fixture",
      },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "native-looking-name": "1.0.0" } }),
    );
    const filename = path.join(owner, "index.js");
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    const transformed = adapter.transform({
      filename,
      contents: "() => require('./platform.node')",
    });
    const { context, root: destination } = evaluate(adapter);
    Object.assign(context, {
      require: createRequire(filename),
      __standaloneNativeCreateRequire: createRequire,
      commonJsEntries: new Set(),
      embedded: () => undefined,
      __openclawStandaloneRootUrl: pathToFileURL(destination + "/").href,
    });
    vm.runInContext(
      createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths: {} }).bootstrap,
      context,
    );
    const load = vm.runInContext(transformed.contents, context);
    expect(load()).toBe("JavaScript platform");
    for (const resource of ["binding.node", "module.wasm"]) {
      const resolve = vm.runInContext(
        adapter.transform({ filename, contents: `() => require.resolve('./${resource}')` })
          .contents,
        context,
      );
      expect(resolve()).toBe(
        `${destination}/native/native-looking-name@1.0.0/native-looking-name/${resource}`,
      );
    }
    const resolveMissing = vm.runInContext(
      adapter.transform({ filename, contents: "() => require.resolve('./missing.node')" }).contents,
      context,
    );
    expect(() => resolveMissing()).toThrow("Cannot find module './missing.node'");
  });

  it("preserves library aliases while copying their bytes as regular files", () => {
    const { root, write, pkg } = fixture();
    const owner = pkg(
      "native-library",
      {},
      { "index.js": "export const url = import.meta.url;", "lib/library.1.dylib": "library" },
    );
    fs.symlinkSync("library.1.dylib", path.join(owner, "lib/library.dylib"));
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "native-library": "1.0.0" } }),
    );
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    adapter.transform({
      filename: path.join(owner, "index.js"),
      contents: "export const url = import.meta.url;",
    });
    const { context, finalized } = evaluate(adapter);
    expect(
      context["__openclawStandaloneNativeResolve"](
        "/relocated/runtime/dist/entry.js",
        "native-library/lib/library.dylib",
      ),
    ).toBe("/relocated/runtime/native/native-library@1.0.0/native-library/lib/library.dylib");
    const alias = finalized.files.find((file: { destination: string }) =>
      file.destination.endsWith("/library.dylib"),
    );
    expect(alias?.source).toBe(`${path.relative(root, owner)}/lib/library.dylib`);
    expect(fs.readFileSync(path.join(root, alias!.source), "utf8")).toBe("library");
  });

  it.each([
    {
      platform: "darwin",
      retained: [
        "bin/arm64/native.dylib",
        "lib/macho.so",
        "lib/universal.node",
        "lib/portable.so",
        "opaque/arm64/tool",
      ],
    },
    {
      platform: "linux",
      retained: ["bin/arm64/native.so", "bin/arm64/tool", "lib/portable.so", "opaque/arm64/tool"],
    },
  ] as const)(
    "selects $platform arm64 resources from native headers and bare architecture directories",
    ({ platform, retained }) => {
      const { root, write, pkg } = fixture();
      const macho = (cpu: number) => {
        const header = Buffer.alloc(32);
        header.writeUInt32LE(0xfeedfacf, 0);
        header.writeUInt32LE(cpu, 4);
        header.writeUInt32LE(6, 12);
        return header;
      };
      const elf = (machine: number) => {
        const header = Buffer.alloc(64);
        header.writeUInt32BE(0x7f454c46, 0);
        header.set([2, 1, 1], 4);
        header.writeUInt16LE(3, 16);
        header.writeUInt16LE(machine, 18);
        header.writeUInt32LE(1, 20);
        header.writeUInt16LE(64, 52);
        return header;
      };
      const universal = Buffer.alloc(112);
      universal.writeUInt32BE(0xcafebabe, 0);
      universal.writeUInt32BE(2, 4);
      for (const [index, cpu] of [0x01000007, 0x0100000c].entries()) {
        universal.writeUInt32BE(cpu, 8 + index * 20);
        universal.writeUInt32BE(48 + index * 32, 16 + index * 20);
        universal.writeUInt32BE(32, 20 + index * 20);
        universal.writeUInt32BE(4, 24 + index * 20);
        macho(cpu).copy(universal, 48 + index * 32);
      }
      const windows = Buffer.alloc(512);
      windows.writeUInt16LE(0x5a4d, 0);
      windows.writeUInt32LE(64, 0x3c);
      windows.writeUInt32LE(0x00004550, 64);
      windows.writeUInt16LE(0xaa64, 68);
      windows.writeUInt16LE(240, 84);
      windows.writeUInt16LE(0x2022, 86);
      windows.writeUInt16LE(0x20b, 88);
      windows.writeUInt32LE(512, 148);
      const files = {
        "bin/arm64/native.dylib": macho(0x0100000c),
        "bin/arm64/native.so": elf(183),
        "bin/x64/native.so": elf(62),
        "bin/arm64/tool": elf(183),
        "lib/macho.so": macho(0x0100000c),
        "lib/wrong-arch.node": macho(0x01000007),
        "lib/universal.node": universal,
        "lib/portable.so": Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
        "lib/windows.dll": windows,
        "opaque/arm64/tool": Buffer.from("opaque"),
        "opaque/x64/tool": Buffer.from("opaque"),
      };
      const owner = pkg("native-matrix", {}, { "index.js": "export {};" });
      for (const [name, bytes] of Object.entries(files)) {
        const filename = path.join(owner, name);
        write(filename);
        fs.writeFileSync(filename, bytes);
        if (name.endsWith("/tool")) {
          fs.chmodSync(filename, 0o755);
        }
      }
      write(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "native-matrix": "1" } }),
      );
      const adapter = createStandaloneNativeAdapter({
        runtimeRoot: root,
        parse,
        platform,
        arch: "arm64",
      });
      adapter.transform({ filename: path.join(owner, "index.js"), contents: "export {};" });
      const actual = adapter
        .finalize()
        .files.filter((file: { category: string }) => file.category !== "dependencyMetadata")
        .map((file: { source: string }) => path.relative(owner, path.join(root, file.source)))
        .toSorted();
      expect(actual).toEqual(retained.toSorted());
    },
  );

  it("captures computed fs-safe/proc-safe and sqlite-vec imports without a pnpm tree", () => {
    const { root, write, pkg } = fixture();
    const fsNative = pkg(
      "@openclaw/fs-safe-darwin-arm64",
      { main: "fs-safe-native.node", os: ["darwin"], cpu: ["arm64"] },
      { "fs-safe-native.node": "fs" },
    );
    const procNative = pkg(
      "@openclaw/proc-safe-darwin-arm64",
      { main: "proc-safe-native.node", os: ["darwin"], cpu: ["arm64"] },
      { "proc-safe-native.node": "proc" },
    );
    const vecNative = pkg("sqlite-vec-darwin-arm64", {}, { "vec0.dylib": "vec" });
    const fsOwner = pkg(
      "@openclaw/fs-safe",
      { optionalDependencies: { "@openclaw/fs-safe-darwin-arm64": "1.0.0" } },
      {
        "dist/native.js": "export const url = import.meta.url;",
        "dist/archive-parser.wasm": "wasm",
        LICENSE: "MIT",
      },
    );
    fs.chmodSync(path.join(fsOwner, "LICENSE"), 0o755);
    const procOwner = pkg(
      "@openclaw/proc-safe",
      { optionalDependencies: { "@openclaw/proc-safe-darwin-arm64": "1.0.0" } },
      { "dist/native.js": "export const url = import.meta.url;" },
    );
    const vecOwner = pkg(
      "sqlite-vec",
      { optionalDependencies: { "sqlite-vec-darwin-arm64": "1.0.0" } },
      { "index.mjs": "export const url = import.meta.url;" },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: {
          "@openclaw/fs-safe": "1.0.0",
          "@openclaw/proc-safe": "1.0.0",
          "sqlite-vec": "1.0.0",
        },
      }),
    );
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    for (const filename of [
      path.join(fsOwner, "dist/native.js"),
      path.join(procOwner, "dist/native.js"),
      path.join(vecOwner, "index.mjs"),
    ]) {
      adapter.transform({ filename, contents: fs.readFileSync(filename, "utf8") });
    }
    const { context, finalized, root: destination } = evaluate(adapter);
    const resolve = context["__openclawStandaloneNativeResolve"];
    const resolutions: Array<[string, string, string]> = [
      [path.join(fsOwner, "dist/native.js"), "@openclaw/fs-safe-darwin-arm64", fsNative],
      [path.join(procOwner, "dist/native.js"), "@openclaw/proc-safe-darwin-arm64", procNative],
      [path.join(vecOwner, "index.mjs"), "sqlite-vec-darwin-arm64/vec0.dylib", vecNative],
    ];
    for (const [owner, specifier, expected] of resolutions) {
      const parent = path.join(destination, path.relative(root, owner));
      const resolved = resolve(pathToFileURL(parent).href, specifier);
      expect(resolved).toContain(`${destination}/native/`);
      expect(resolved).not.toContain(".pnpm");
      expect(
        finalized.files.some((file: { source: string }) =>
          file.source.startsWith(path.relative(root, expected)),
        ),
      ).toBe(true);
    }
    const parent = path.join(destination, path.relative(root, fsOwner), "dist/native.js");
    expect(resolve(parent, "../package.json")).toMatch(/native\/.+\/package\.json$/);
    expect(
      finalized.files.filter((file: { category: string }) => file.category === "nativeAddons"),
    ).toHaveLength(2);
    expect(
      finalized.files.some((file: { destination: string }) =>
        file.destination.endsWith("archive-parser.wasm"),
      ),
    ).toBe(true);
    expect(
      finalized.files.every(
        (file: { destination: string }) =>
          !file.destination.includes(".pnpm") && !/\.[cm]?js$/.test(file.destination),
      ),
    ).toBe(true);
    const report = pruneStandaloneRuntime(planStandaloneRuntime(root, finalized.files));
    expect(report.categories.dependencyLicenses?.files).toBe(1);
    expect(
      fs.readFileSync(
        path.join(root, "native/@openclaw+fs-safe@1.0.0/@openclaw/fs-safe/LICENSE"),
        "utf8",
      ),
    ).toBe("MIT");
  });

  it("resolves a computed native library from transformed CommonJS after pruning", () => {
    const { root, write, pkg } = fixture();
    pkg("sqlite-vec-darwin-arm64", {}, { "vec0.dylib": "native-library" });
    const source =
      'exports.getLoadablePath = () => require.resolve("sqlite-vec-darwin-arm64/" + "vec0.dylib");';
    const owner = pkg(
      "sqlite-vec",
      { main: "index.cjs", optionalDependencies: { "sqlite-vec-darwin-arm64": "1.0.0" } },
      { "index.cjs": source },
    );
    write(path.join(root, "package.json"), JSON.stringify({ dependencies: { "sqlite-vec": "1" } }));
    const filename = path.join(owner, "index.cjs");
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    const transformed = adapter.transform({ filename, contents: source });
    const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths: {} });
    const finalized = adapter.finalize();
    pruneStandaloneRuntime(planStandaloneRuntime(root, finalized.files));
    const context = vm.createContext({
      root,
      path,
      fileURLToPath,
      embedded: () => undefined,
      __standaloneNativeCreateRequire: createRequire,
      __openclawStandaloneRootUrl: pathToFileURL(root + "/").href,
      require: createRequire(filename),
      exports: {},
    });
    // Adapter discovery can cache resolutions; a fresh process proves the pruned image has no fallback.
    const untransformed = spawnSync(
      process.execPath,
      [
        "--eval",
        `const require = process.getBuiltinModule("module").createRequire(${JSON.stringify(filename)});
const exports = {};
${source}
try { exports.getLoadablePath(); } catch (error) { console.error(error.code); process.exit(1); }`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(untransformed.status, untransformed.stderr).toBe(1);
    expect(untransformed.stderr.trim()).toBe("MODULE_NOT_FOUND");
    vm.runInContext(
      adapter.bootstrap
        .replace(/^import[^\n]+\n/, "")
        .replace(
          finalized.bootstrapReplacement.search,
          finalized.bootstrapReplacement.replacement,
        ) +
        requireAdapter.bootstrap +
        transformed.contents,
      context,
    );
    const resolved = vm.runInContext("exports.getLoadablePath()", context);
    expect(resolved).toBe(
      path.join(root, "native/sqlite-vec-darwin-arm64@1.0.0/sqlite-vec-darwin-arm64/vec0.dylib"),
    );
    expect(fs.readFileSync(resolved, "utf8")).toBe("native-library");
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
  });

  it("rebases resource expressions and resolves embedded optional wrappers through their original identity", () => {
    const { root, write, pkg } = fixture();
    const native = pkg(
      "terminal-native",
      { main: "lib/index.js", type: "commonjs" },
      {
        "lib/index.js": "module.exports = require('../binding.node');",
        "binding.node": "native",
        "assets/table.wasm": "wasm",
        "prebuilds/linux-x64/unused.node": "other-host",
      },
    );
    const owner = pkg(
      "terminal",
      { optionalDependencies: { "terminal-native": "1.0.0" } },
      { "index.js": "module.exports = require(selected);" },
    );
    write(path.join(root, "package.json"), JSON.stringify({ dependencies: { terminal: "1.0.0" } }));
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    expect(adapter.additionalModuleEntries).toEqual([
      path.relative(root, path.join(native, "lib/index.js")),
    ]);
    adapter.transform({
      filename: path.join(owner, "index.js"),
      contents: "module.exports = require(selected);",
    });
    const source =
      "(() => [__dirname, __filename, import.meta.url, import.meta.dirname, '__dirname'])";
    const transformed = adapter.transform({
      filename: path.join(native, "lib/index.js"),
      contents: source,
    });
    const embedded = "/$bunfs/root/terminal-native.js";
    const {
      context,
      finalized,
      root: destination,
    } = evaluate(adapter, { [path.relative(root, path.join(native, "lib/index.js"))]: embedded });
    context["__openclawStandaloneRootUrl"] = pathToFileURL(destination + "/").href;
    const values = vm.runInContext(transformed.contents, context)();
    expect(values[0]).toBe(`${destination}/native/terminal-native@1.0.0/terminal-native/lib`);
    expect(values[1]).toBe(`${values[0]}/index.js`);
    expect(values[2]).toBe(pathToFileURL(values[1]).href);
    expect(values[3]).toBe(values[0]);
    expect(values[4]).toBe("__dirname");
    expect(
      context["__openclawStandaloneNativeResolve"](
        path.join(destination, path.relative(root, owner), "index.js"),
        "terminal-native",
      ),
    ).toBe(path.join(destination, path.relative(root, native), "lib/index.js"));
    expect(
      finalized.files.some((file: { source: string }) => file.source.includes("unused.node")),
    ).toBe(false);
  });

  it("keeps plugin asset roots and shadowed bindings while resolving core package resources", () => {
    const { root, write, pkg } = fixture();
    const native = pkg("native-helper", { main: "binding.node" }, { "binding.node": "native" });
    write(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", dependencies: { "native-helper": "1.0.0" } }),
    );
    const plugin = path.join(root, "dist/extensions/example");
    write(path.join(plugin, "package.json"), JSON.stringify({ name: "example-plugin" }));
    write(path.join(plugin, "helper.wasm"), "plugin");
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    const pluginCode = "const asset = new URL('./helper.wasm', import.meta.url);";
    expect(
      adapter.transform({ filename: path.join(plugin, "index.js"), contents: pluginCode }).contents,
    ).toBe(pluginCode);
    const source =
      "(() => [((__dirname) => __dirname)('local'), {__dirname}, (() => { const __filename = 'bound'; return __filename; })()])";
    const transformed = adapter.transform({
      filename: path.join(native, "binding.js"),
      contents: source,
    });
    const { context, root: destination } = evaluate(adapter);
    const values = vm.runInContext(transformed.contents, context)();
    expect(values[0]).toBe("local");
    expect(values[1]["__dirname"]).toBe(`${destination}/native/native-helper@1.0.0/native-helper`);
    expect(values[2]).toBe("bound");
    expect(
      context["__openclawStandaloneNativeResolve"](`${destination}/dist/entry.js`, "native-helper"),
    ).toBe(`${destination}/native/native-helper@1.0.0/native-helper/binding.node`);
    expect(
      context["__openclawStandaloneNativeResolve"](
        "/external/plugins/example/index.js",
        "native-helper",
      ),
    ).toBeUndefined();
    expect(
      context["__openclawStandaloneNativeResolve"](
        "/external/plugins/example/index.js",
        "./binding.node",
      ),
    ).toBeUndefined();
  });

  it("preserves the separate Copilot runtime contract and package search paths", () => {
    const { root, write, pkg } = fixture();
    const platformName = "@github/copilot-sdk-darwin-arm64";
    const runtime = pkg(
      platformName,
      {},
      {
        "prebuilds/darwin-arm64/runtime.node": "native",
        "prebuilds/darwin-arm64/copilot-runtime": "executable",
        "copilot-sdk/extension.js": "export const external = true;",
        "schemas/api.schema.json": "{}",
        "definitions/task.agent.yaml": "name: task",
        "plugins/computer-use/plugin.json": "{}",
        "plugins/guest.dll": "MZguest",
        "runtimes/linux-x64/guest.so": "\u007fELFguest",
        "assets/unused.png": "excluded by runtime owner",
        "index.js": "excluded by runtime owner",
      },
    );
    const sdk = pkg(
      "@github/copilot-sdk",
      { optionalDependencies: { [platformName]: "1.0.0" } },
      { "dist/runtimeArtifacts.js": "export const url = import.meta.url;" },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "@github/copilot-sdk": "1.0.0" } }),
    );
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    adapter.transform({
      filename: path.join(sdk, "dist/runtimeArtifacts.js"),
      contents: "export const url = import.meta.url;",
    });
    const { context, finalized, root: destination } = evaluate(adapter);
    const search = context["__openclawStandaloneNativeResolvePaths"](
      path.join(destination, path.relative(root, sdk), "dist/runtimeArtifacts.js"),
      platformName,
    );
    expect(search).toEqual([`${destination}/native/@github+copilot-sdk-darwin-arm64@1.0.0`]);
    expect(
      context["__openclawStandaloneNativeResolvePaths"]("/external/plugin/index.js", platformName),
    ).toBeUndefined();
    const sources = finalized.files.map((file: { source: string }) => file.source);
    expect(sources).toContain(`${path.relative(root, runtime)}/copilot-sdk/extension.js`);
    expect(sources).toContain(`${path.relative(root, runtime)}/definitions/task.agent.yaml`);
    expect(sources).toContain(`${path.relative(root, runtime)}/plugins/guest.dll`);
    expect(sources).toContain(`${path.relative(root, runtime)}/runtimes/linux-x64/guest.so`);
    expect(sources).not.toContain(`${path.relative(root, runtime)}/assets/unused.png`);
    expect(sources).not.toContain(`${path.relative(root, runtime)}/index.js`);
    expect(() =>
      adapter.finalize({
        embeddedPaths: {
          [`${path.relative(root, runtime)}/copilot-sdk/extension.js`]: "/$bunfs/duplicate.js",
        },
      }),
    ).toThrow("already embedded");
  });

  it("does not admit installed development prebuilds or resources absent from the runtime graph", () => {
    const { root, write, pkg } = fixture();
    pkg("dev-native", { main: "binding.node" }, { "binding.node": "dev" });
    pkg("unused-native", { main: "binding.node" }, { "binding.node": "unused" });
    write(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { "unused-native": "1.0.0" },
        devDependencies: { "dev-native": "1.0.0" },
      }),
    );
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    expect(adapter.finalize().files).toEqual([]);
    expect(adapter.additionalModuleEntries).toEqual([]);
  });
});
