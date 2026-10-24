import vm from "node:vm";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { rewriteStandaloneImports } from "../../scripts/lib/bun-standalone-imports.mjs";

const runtimeRoot = "/removed-build/runtime";
const filename = `${runtimeRoot}/dist/entry.mjs`;
const relocatedRoot = "file:///relocated-app/runtime/";
const moduleAliases = {
  ws: `${runtimeRoot}/node_modules/ws/index.js`,
  undici: `${runtimeRoot}/node_modules/undici/index.js`,
};
const workerThreadsShim = "/removed-build/standalone-worker-threads.cjs";
const embeddedPaths = {
  "node_modules/ws/index.js": "/$bunfs/root/runtime/node_modules/ws/index.js",
  "node_modules/undici/index.js": "/$bunfs/root/runtime/node_modules/undici/index.js",
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
  it.each([
    [moduleAliases.ws, embeddedPaths["node_modules/ws/index.js"]],
    [moduleAliases.undici, embeddedPaths["node_modules/undici/index.js"]],
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
