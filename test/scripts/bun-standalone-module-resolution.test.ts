import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { moduleResolve } from "import-meta-resolve";
import { afterEach, describe, expect, it } from "vitest";
import { rewriteStandaloneImports } from "../../scripts/lib/bun-standalone-imports.mjs";
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
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-module-resolution-"));
  temporary.push(root);
  function write(filename: string, contents: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  write(path.join(root, "package.json"), '{"name":"openclaw"}');
  const library = path.join(root, "node_modules/factory-library");
  write(
    path.join(library, "package.json"),
    JSON.stringify({
      name: "factory-library",
      version: "1.0.0",
      exports: { ".": { import: "./import.mjs", require: "./lib%20%23/factory.cjs" } },
    }),
  );
  write(path.join(library, "import.mjs"), 'throw new Error("wrong export condition");');
  const filename = path.join(root, "dist/factory.mjs");
  const source = `import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { moduleResolve as lookup } from "import-meta-resolve";
let factory;
export function loadFactory(value) {
  if (!factory) {
    const entry = lookup("factory-library", new URL(import.meta.url), new Set(["node", "require"]));
    factory = createRequire(import.meta.url)(fileURLToPath(entry)).createFactory;
  }
  return factory(value);
}`;
  write(filename, source);
  return { root, library, filename, source, write };
}

describe("standalone conditional module resolution", () => {
  it("retains shared-loader builtins without initializing them before the first require", () => {
    const { root, write } = fixture();
    write(
      path.join(root, "shared.mjs"),
      'import { createRequire } from "node:module"; export const load = createRequire(import.meta.url);',
    );
    write(
      path.join(root, "entry.mjs"),
      `import { load } from "./shared.mjs";
const selected = "node:vm";
export const read = () => load(selected).runInNewContext("6 * 7");
export const spawn = () => load("node:child_process");
export const overridden = () => load("node:path");
const hidden = "node:crypto";
function shadow(hidden) { return load(hidden); }
report("bun:unknown");
report("node:unknown");`,
    );
    write(path.join(root, "plain.cjs"), 'module.exports = { value: "ordinary-file" };');
    const native = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    native.discover(["shared.mjs", "entry.mjs"]);
    expect(native.builtinModules).toEqual([
      "node:child_process",
      "node:module",
      "node:path",
      "node:vm",
    ]);
    const override = path.join(root, "override.cjs");
    write(override, 'module.exports = { value: "embedded-alias" };');
    const adapter = createStandaloneRequireAdapter({
      runtimeRoot: root,
      embeddedPaths: { "node:path": override },
    });
    const replacement = adapter.finalize(native.builtinModules);
    write(
      path.join(root, "probe.mjs"),
      `import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = ${JSON.stringify(root)};
const loaded = [];
const nativeRequire = createRequire(import.meta.url);
import.meta.require = (specifier) => { loaded.push(specifier); return nativeRequire(specifier); };
const embedded = (specifier) => specifier === "node:path" ? ${JSON.stringify(override)} : undefined;
const commonJsEntries = new Set();
globalThis.__openclawStandaloneNativeResolve = () => undefined;
${adapter.bootstrap.replace(replacement.search, replacement.replacement)}
const load = globalThis.__openclawStandaloneCreateRequire(createRequire, import.meta.url);
const before = loaded.slice();
const answer = load("node:vm").runInNewContext("6 * 7");
const file = load("./plain.cjs").value;
const alias = load("node:path").value;
console.log(JSON.stringify({ before, answer, file, alias, loaded }));`,
    );
    const result = spawnSync(process.execPath, [path.join(root, "probe.mjs")], {
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      before: [],
      answer: 42,
      file: "ordinary-file",
      alias: "embedded-alias",
      loaded: ["node:vm"],
    });
  });

  it.each(["emitted", "typed"])(
    "loads the %s require export lazily after pruning and relocation without package-manager paths",
    (mode) => {
      const { root, library, filename: emittedFilename, source, write } = fixture();
      let filename = emittedFilename;
      if (mode === "typed") {
        const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-module-source-"));
        temporary.push(sourceRoot);
        write(path.join(sourceRoot, "package.json"), '{"name":"openclaw","type":"module"}');
        const original = path.join(sourceRoot, "src/factory.ts");
        write(original, source);
        const config = { entry: { factory: "src/factory.ts" } };
        const graph = createStandaloneSourceGraph({
          sourceRoot,
          runtimeRoot: root,
          outputRoot: path.dirname(root),
          sourceEntries: createStandaloneSourceEntries({ sourceRoot, configs: [config] }),
          embeddedPaths: {},
        });
        filename = graph.addSource(original, config);
      }
      const image = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-module-image-"));
      temporary.push(image);
      const factoryMarker = path.join(image, "factory-loaded");
      const transformMarker = path.join(image, "transform-loaded");
      const entry = path.join(library, "lib #/factory.cjs");
      const factorySource = `require("node:fs").writeFileSync(${JSON.stringify(factoryMarker)}, "loaded");
exports.createFactory = value => ({ read: () => require("./transform.cjs")(value) });`;
      const transformSource = `require("node:fs").writeFileSync(${JSON.stringify(transformMarker)}, "loaded");
module.exports = value => value + " transformed";`;
      write(entry, factorySource);
      write(path.join(path.dirname(entry), "transform.cjs"), transformSource);
      const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
      adapter.discover([path.relative(root, filename)]);
      expect(adapter.additionalModuleEntries).toEqual([path.relative(root, entry)]);
      expect(adapter.commonJsEntries).toEqual([path.relative(root, entry)]);
      const transformed = adapter.transform({ filename, contents: source });
      adapter.transform({ filename: entry, contents: factorySource });
      const imageEntry = path.join(image, "factory.cjs");
      write(imageEntry, factorySource);
      write(path.join(image, "transform.cjs"), transformSource);
      const embeddedPaths = { [path.relative(root, entry)]: imageEntry };
      const rewritten = rewriteStandaloneImports({
        contents: transformed.contents,
        filename,
        runtimeRoot: root,
        embeddedPaths,
        moduleAliases: {},
        workerThreadsShim: path.join(root, "worker-shim.mjs"),
        parse,
      });
      const finalized = adapter.finalize({ embeddedPaths });
      const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths });
      pruneStandaloneRuntime(planStandaloneRuntime(root, finalized.files));
      const relocated = `${root} moved #`;
      fs.renameSync(root, relocated);
      temporary.push(relocated);
      const context = vm.createContext({
        root: relocated,
        path,
        URL,
        lookup: moduleResolve,
        fileURLToPath,
        createRequire,
        commonJsEntries: new Set(),
        embedded: (target: string) =>
          target === imageEntry ? imageEntry : embeddedPaths[path.relative(relocated, target)],
        __openclawStandaloneRootUrl: pathToFileURL(relocated + path.sep).href,
      });
      vm.runInContext(
        adapter.bootstrap
          .replace(/^import[^\n]+\n/, "")
          .replace(
            finalized.bootstrapReplacement.search,
            finalized.bootstrapReplacement.replacement,
          ),
        context,
      );
      vm.runInContext(requireAdapter.bootstrap, context);
      vm.runInContext(
        rewritten.replace(/^import[^\n]+\n/gm, "").replace("export function", "function") +
          "\nglobalThis.loadFactory = loadFactory;",
        context,
      );
      expect(fs.existsSync(factoryMarker)).toBe(false);
      const loader = context.loadFactory("value");
      expect(fs.existsSync(factoryMarker)).toBe(true);
      expect(fs.existsSync(transformMarker)).toBe(false);
      expect(loader.read()).toBe("value transformed");
      expect(fs.existsSync(transformMarker)).toBe(true);
      expect(fs.existsSync(path.join(relocated, "node_modules"))).toBe(false);
      expect(fs.existsSync(path.join(relocated, path.relative(root, entry)))).toBe(false);
    },
  );

  it.each([
    'const conditions = ["node", "require"]; lookup("factory-library", new URL(import.meta.url), new Set(conditions));',
    'const specifier = "factory-library"; lookup(specifier, new URL(import.meta.url), new Set(["node", "require"]));',
    'function select(lookup) { return lookup("factory-library", new URL(import.meta.url), new Set(["node", "require"])); }',
    'function select(URL) { return lookup("factory-library", new URL(import.meta.url), new Set(["node", "require"])); }',
    'function select(Set) { return lookup("factory-library", new URL(import.meta.url), new Set(["node", "require"])); }',
  ])("leaves dynamic and shadowed resolution with its runtime owner: %s", (body) => {
    const { root, filename, write } = fixture();
    const source = `import { moduleResolve as lookup } from "import-meta-resolve";\n${body}`;
    write(filename, source);
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    adapter.discover([path.relative(root, filename)]);
    expect(adapter.additionalModuleEntries).toEqual([]);
    expect(adapter.transform({ filename, contents: source }).contents).toBe(source);
  });
});
