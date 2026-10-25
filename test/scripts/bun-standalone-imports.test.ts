import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { parse as parseBabel } from "@babel/parser";
import traverse from "@babel/traverse";
import { describe, expect, it } from "vitest";
import {
  assertNoUnrenderedModuleUrls,
  createUnrenderedModuleUrlBootstrap,
  rewriteStandaloneImports,
} from "../../scripts/lib/bun-standalone-imports.mjs";
import { createStandaloneSourceGlobals } from "../../scripts/lib/bun-standalone-source-globals.mjs";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";
import { typeCheckSources } from "../helpers/typescript.js";

const parse = createStandaloneSourceParser();
const runtimeRoot = "/removed-build/runtime";
const filename = `${runtimeRoot}/dist/entry.mjs`;
const relocatedRoot = "file:///relocated-app/runtime/";
const moduleAliases = {
  ws: `${runtimeRoot}/node_modules/ws/index.js`,
};
const workerThreadsShim = "/removed-build/standalone-worker-threads.cjs";
const embeddedPaths = {
  "node_modules/ws/index.js": "/$bunfs/root/runtime/node_modules/ws/index.js",
  "../standalone-worker-threads.cjs": "/$bunfs/root/standalone-worker-threads.js",
};

function rewrite(contents: string, entries: Record<string, string> = embeddedPaths) {
  return rewriteStandaloneImports({
    contents,
    filename,
    runtimeRoot,
    embeddedPaths: entries,
    moduleAliases,
    workerThreadsShim,
    parse,
  });
}

describe("standalone import relocation", () => {
  it("defers a known unrendered URL without inventing a runtime path", () => {
    const contents = rewriteStandaloneImports({
      contents: "(() => import.meta.url)",
      filename,
      runtimeRoot,
      embeddedPaths,
      moduleAliases,
      workerThreadsShim,
      resolveModuleUrl: () => null,
      parse,
    });
    const context = vm.createContext({});
    vm.runInContext(createUnrenderedModuleUrlBootstrap(), context);
    const read = vm.runInContext(contents, context);
    expect(read).toThrow("OPENCLAW_UNRENDERED_MODULE_URL:dist/entry.mjs");
    expect(() => assertNoUnrenderedModuleUrls(contents, "entry.js")).toThrow(
      "An unrendered source module URL survived bundling in entry.js",
    );
  });

  it("preserves a default URL's string contract when its source is unrendered", () => {
    const source = `const readCommitFromBuildInfo = (moduleUrl = import.meta.url) => moduleUrl;
const readLoadedCommit = (moduleUrl: string) => readCommitFromBuildInfo(moduleUrl);
const result: string = readLoadedCommit("file:///explicit.mjs");
[result, readCommitFromBuildInfo];`;
    const contents = rewriteStandaloneImports({
      contents: source,
      filename,
      runtimeRoot,
      embeddedPaths,
      moduleAliases,
      workerThreadsShim,
      resolveModuleUrl: () => null,
      parse: createStandaloneSourceParser(),
      preserveTypes: true,
    });
    expect(
      typeCheckSources({
        "globals.d.ts": `/// <reference types="node" />\n${createStandaloneSourceGlobals()}`,
        "consumer.ts": contents,
      }),
    ).toEqual([]);
    const context = vm.createContext({});
    vm.runInContext(createUnrenderedModuleUrlBootstrap(), context);
    const [result, read] = vm.runInContext(stripTypeScriptTypes(contents), context);
    expect(result).toBe("file:///explicit.mjs");
    expect(read).toThrow("OPENCLAW_UNRENDERED_MODULE_URL:dist/entry.mjs");
  });

  it("retains the typed resolver's receiver, arguments, return and restoration contracts", () => {
    const source = `type Resolver = (this: { calls: number }, request: string, parent: string | undefined, isMain: boolean, options?: { paths: string[] }) => string;
const original: Resolver = function (request) { return request; };
const holder: { module: { calls: number; _resolveFilename?: Resolver } } = { module: { calls: 0, _resolveFilename: original } };
const seen: unknown[] = [];
holder.module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "throw") throw new Error("resolver failure");
  this.calls += 1;
  seen.push([parent, isMain, options?.paths]);
  return request;
};
const mapped: string = holder.module._resolveFilename("/physical/entry.js", "parent", false, { paths: ["root"] });
const externalResult: string = holder.module._resolveFilename("/external/entry.js", undefined, true);
let error: string | undefined;
try { holder.module._resolveFilename("throw", undefined, false); } catch (caught) { error = caught instanceof Error ? caught.message : "unknown"; }
holder.module._resolveFilename = original;
[mapped, externalResult, holder.module.calls, holder.module._resolveFilename === original, error, seen];`;
    const contents = rewriteStandaloneImports({
      contents: source,
      filename,
      runtimeRoot,
      embeddedPaths,
      moduleAliases,
      workerThreadsShim,
      parse: createStandaloneSourceParser(),
      preserveTypes: true,
    });
    const declarations = `declare var __openclawStandaloneEmbeddedPath: (path: string) => string | undefined;\n`;
    expect(typeCheckSources({ "resolver.ts": declarations + contents })).toEqual([]);
    const result = vm.runInNewContext(stripTypeScriptTypes(contents), {
      __openclawStandaloneEmbeddedPath: (target: string) =>
        target === "/physical/entry.js" ? "/$bunfs/root/entry.js" : undefined,
    });
    expect(result).toEqual([
      "/$bunfs/root/entry.js",
      "/external/entry.js",
      2,
      true,
      "resolver failure",
      [
        ["parent", false, ["root"]],
        [undefined, true, undefined],
      ],
    ]);
  });

  it("keeps a typed root's published module URL while its compiler input is staged elsewhere", async () => {
    const rewritten = rewriteStandaloneImports({
      contents: "(async () => [import.meta.url, await import(target)])",
      filename: `${runtimeRoot}/.typed-source/core/src/entry.ts`,
      physicalFilename: `${runtimeRoot}/dist/entry.js`,
      runtimeRoot,
      embeddedPaths,
      moduleAliases,
      workerThreadsShim,
      parse: createStandaloneSourceParser(),
      preserveTypes: true,
    });
    const load = vm.runInNewContext(rewritten, {
      target: "./next.js",
      __openclawStandaloneRootUrl: relocatedRoot,
      __openclawStandaloneImport: async (parent: string, target: string) =>
        new URL(target, parent).href,
    });
    expect(await load()).toEqual([`${relocatedRoot}dist/entry.js`, `${relocatedRoot}dist/next.js`]);
  });

  it("retains the import type witness without evaluating computed arguments again", async () => {
    const source = "(async () => import(next(), options()))";
    const rewritten = rewriteStandaloneImports({
      contents: source,
      filename,
      runtimeRoot,
      embeddedPaths,
      moduleAliases,
      workerThreadsShim,
      parse: createStandaloneSourceParser(),
      preserveTypes: true,
    });
    let specifiers = 0;
    let options = 0;
    const value = { answer: 42 };
    const load = vm.runInNewContext(rewritten, {
      __openclawStandaloneRootUrl: relocatedRoot,
      next: () => {
        specifiers++;
        return "./leaf.ts";
      },
      options: () => {
        options++;
        return { with: { type: "json" } };
      },
      __openclawStandaloneImport: async (
        _parent: string,
        target: string,
        attributes: unknown,
        witness: () => Promise<unknown>,
      ) => {
        expect(target).toBe("./leaf.ts");
        expect(attributes).toEqual({ with: { type: "json" } });
        expect(typeof witness).toBe("function");
        return value;
      },
    });
    expect(await load()).toEqual(value);
    expect([specifiers, options]).toEqual([1, 1]);
    expect(rewritten).toContain("() => import(next(), options())");
  });

  it.each<[string, string[]]>([
    ['const target = "./leaf.js"; import(target);', ["./leaf.js"]],
    ["const target = `./leaf.js`; import(target);", ["./leaf.js"]],
    ['async function read() { const target = "./leaf.js"; return import(target); }', ["./leaf.js"]],
    ['{ const target = "./leaf.js"; import(target); }', ["./leaf.js"]],
    ['function read() { return import(target); } const target = "./leaf.js";', ["./leaf.js"]],
    ['const target = "./leaf.js"; ({target: other} = record); import(target);', ["./leaf.js"]],
    [
      'const target = "./outer.js"; class C { static { const target = "./inner.js"; import(target); } } import(target);',
      ["./outer.js", "./inner.js"],
    ],
    [
      'const target = "./outer.js"; class C { static { var target = "./inner.js"; import(target); } } import(target);',
      ["./outer.js"],
    ],
    [
      'const target = "./outer.js"; switch (import(target)) { default: const target = "./inner.js"; import(target); }',
      ["./inner.js", "./outer.js"],
    ],
    [
      'const target = "./outer.js"; function read(value = import(target)) { var target = "./inner.js"; return value; }',
      ["./outer.js"],
    ],
    [
      'const target = "./outer.js"; class C { constructor(public target: string) { import(target); } } import(target);',
      ["./outer.js"],
    ],
    [
      'const target = "./outer.js"; namespace N { const target = "./inner.js"; export function read() { return import(target); } } import(target);',
      ["./outer.js", "./inner.js"],
    ],
    [
      'const target = "./outer.js"; function read() { enum target { A } return import(target); }',
      [],
    ],
    [
      'const target = "./outer.js"; namespace N { import target = Other.target; export function read() { return import(target); } }',
      [],
    ],
    ['let target = "./leaf.js"; target = "./other.js"; import(target);', []],
    ['const target = "./leaf.js"; function read(target) { return import(target); }', []],
    [
      'const target = "./leaf.js"; { import(target); const target = "./other.js"; }',
      ["./other.js"],
    ],
    ['const target = "./leaf.js"; try {} catch (target) { import(target); }', []],
    ['const target = "./leaf.js"; for (const target of values) { import(target); }', []],
    [
      'const target = "./leaf.js"; const read = class target { read() { return import(target); } };',
      [],
    ],
    ['const target = "./leaf.js"; if (false) target = "./other.js"; import(target);', []],
    ['import(target); const target = "./leaf.js";', ["./leaf.js"]],
  ])("exposes only immutable lexical literals to source discovery: %s", (source, expected) => {
    const sourceParser = createStandaloneSourceParser();
    const rewritten = rewriteStandaloneImports({
      contents: source,
      filename,
      runtimeRoot,
      embeddedPaths,
      moduleAliases,
      workerThreadsShim,
      parse: sourceParser,
      preserveTypes: true,
    });
    const imports: string[] = [];
    traverse(
      parseBabel(rewritten, {
        sourceType: "module",
        plugins: ["typescript", "decorators-legacy"],
      }),
      {
        ImportExpression({ node }) {
          if (node.source.type === "StringLiteral") {
            imports.push(node.source.value);
          }
        },
      },
    );
    expect(imports.toSorted()).toEqual(expected.toSorted());
  });

  it("keeps const-import typing, shadowing and temporal-dead-zone evaluation", async () => {
    const source = `const target = "./leaf.js";
async function read(): Promise<number> { return (await import(target)).answer; }
async function shadow(target: string) { return await import(target); }
let early: string | undefined;
try { import(later); } catch (error) { early = error instanceof ReferenceError ? "tdz" : "other"; }
const later = "./later.js";
[read, shadow, early];`;
    const rewritten = rewriteStandaloneImports({
      contents: source,
      filename,
      runtimeRoot,
      embeddedPaths,
      moduleAliases,
      workerThreadsShim,
      parse: createStandaloneSourceParser(),
      preserveTypes: true,
    });
    const diagnostics = typeCheckSources({
      "globals.d.ts": `/// <reference types="node" />\n${createStandaloneSourceGlobals()}`,
      "consumer.ts": rewritten,
      "leaf.ts": "export const answer: number = 42;",
      "later.ts": "export const answer: number = 9;",
    });
    // The original early read must remain an error even after discovery normalization.
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([2448, 2454]);
    expect(
      typeCheckSources({
        "globals.d.ts": `/// <reference types="node" />\n${createStandaloneSourceGlobals()}`,
        "consumer.ts": rewritten,
        "leaf.ts": 'export const answer: string = "invalid";',
        "later.ts": "export const answer: number = 9;",
      }).some((diagnostic) => diagnostic.code === 2322),
    ).toBe(true);
    const targets: string[] = [];
    const [read, shadow, early] = vm.runInNewContext(stripTypeScriptTypes(rewritten), {
      __openclawStandaloneRootUrl: relocatedRoot,
      __openclawStandaloneImport: async (_parent: string, target: string) => {
        targets.push(target);
        return { answer: 42 };
      },
    });
    expect(await read()).toBe(42);
    expect(await shadow("./shadow.js")).toEqual({ answer: 42 });
    expect(early).toBe("tdz");
    expect(targets).toEqual(["./leaf.js", "./shadow.js"]);
  });

  it.each([
    [moduleAliases.ws, embeddedPaths["node_modules/ws/index.js"]],
    [workerThreadsShim, embeddedPaths["../standalone-worker-threads.cjs"]],
  ])("loads the embedded image after the build path disappears: %s", async (source, expected) => {
    const calls: { parent: string; target: string }[] = [];
    const load = vm.runInNewContext(rewrite(`(async () => import(${JSON.stringify(source)}))`), {
      __openclawStandaloneRootUrl: relocatedRoot,
      __openclawStandaloneImport: async (parent: string, target: string) => {
        calls.push({ parent, target });
        if (target.startsWith("/removed-build/")) {
          throw new Error("Build directory is gone");
        }
        return { loaded: target };
      },
    });
    expect(await load()).toEqual({ loaded: expected });
    expect(calls).toEqual([{ parent: `${relocatedRoot}dist/entry.mjs`, target: expected }]);
  });

  it("resolves computed relative imports from the relocated importer and retains options", async () => {
    const calls: { parent: string; target: string; options: unknown }[] = [];
    const load = vm.runInNewContext(
      rewrite("(async (specifier, options) => import(specifier, options))"),
      {
        __openclawStandaloneRootUrl: relocatedRoot,
        __openclawStandaloneImport: async (parent: string, target: string, options: unknown) => {
          calls.push({ parent, target, options });
          return new URL(target, parent).href;
        },
      },
    );
    const options = { with: { type: "json" } };
    expect(await load("./metadata.json", options)).toBe(`${relocatedRoot}dist/metadata.json`);
    expect(calls).toEqual([
      { parent: `${relocatedRoot}dist/entry.mjs`, target: "./metadata.json", options },
    ]);
  });

  it("preserves quoted source while rebasing actual import.meta.url expressions", async () => {
    const source = 'const literal = "import.meta.url"; (async () => [literal, import.meta.url])';
    const load = vm.runInNewContext(rewrite(source), {
      __openclawStandaloneRootUrl: relocatedRoot,
    });
    expect(await load()).toEqual(["import.meta.url", `${relocatedRoot}dist/entry.mjs`]);
    const staticImport = 'import value from "./unchanged.mjs"; const literal = "import.meta.url";';
    expect(rewrite(staticImport)).toBe(staticImport);
  });

  it("fails the build when a generated alias has no embedded entry", () => {
    expect(() => rewrite(`import(${JSON.stringify(moduleAliases.ws)})`, {})).toThrow(
      "Missing embedded standalone import: node_modules/ws/index.js",
    );
  });

  it.each([
    ["installResolver", "openclaw-plugin-sdk-alias"],
    ["installCapturedPluginModuleResolver", "openclaw-plugin-source-capture"],
    ["minified", "openclaw-plugin-sdk-alias"],
  ])("keeps %s hook results inside the image for embedded SDK modules", (owner, name) => {
    const source = `function ${owner}() {
      Bun.plugin({ name: \`${name}\`, setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path: t }) =>
          t ? { path: t, namespace: \`file\` } : undefined);
      }});
    }
    ${owner}();`;
    let resolve: (args: { path: string }) => { path: string; namespace: string };
    const sdk = "/relocated-app/runtime/dist/plugin-sdk/plugin-entry.js";
    const image = "/$bunfs/root/runtime/dist/plugin-sdk/plugin-entry.js";
    vm.runInNewContext(rewrite(source), {
      Bun: {
        plugin: ({ setup }: { setup: (builder: unknown) => void }) =>
          setup({
            onResolve: (_options: unknown, callback: typeof resolve) => (resolve = callback),
          }),
      },
      __openclawStandaloneEmbeddedPath: (target: string) => (target === sdk ? image : undefined),
    });
    expect(resolve!({ path: sdk })).toEqual({ path: image, namespace: "file" });
    const installed = "/profile/plugins/matrix/entry.js";
    expect(resolve!({ path: installed })).toEqual({ path: installed, namespace: "file" });
  });

  it("rejects a changed native plugin resolver contract", () => {
    expect(() =>
      rewrite('function installResolver() { return "openclaw-plugin-sdk-alias"; }'),
    ).toThrow("Unsupported standalone plugin resolver: openclaw-plugin-sdk-alias");
  });

  it.each(["key", '"_resolveFilename"', "direct"])(
    "maps the CJS %s resolver handoff while preserving external paths and restoration",
    (property) => {
      const access = property === "direct" ? "._resolveFilename" : `[${property}]`;
      const source = `const key = "_resolveFilename";
        const original = (value) => value;
        const Module = { _resolveFilename: original };
        Module${access} = function (value) { this.calls += 1; return value; };
        Module.calls = 0;
        const mapped = Module${access}("/app/runtime/dist/plugin-sdk/entry.js");
        const external = Module${access}("/profile/plugins/entry.cjs");
        Module${access} = original;
        [mapped, external, Module.calls, Module${access} === original];`;
      const result = vm.runInNewContext(rewrite(source), {
        __openclawStandaloneEmbeddedPath: (target: string) =>
          target === "/app/runtime/dist/plugin-sdk/entry.js" ? "/$bunfs/root/sdk.js" : undefined,
      });
      expect(result).toEqual(["/$bunfs/root/sdk.js", "/profile/plugins/entry.cjs", 2, true]);
    },
  );
});
