import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { requirePinnedBun } from "../../scripts/lib/pinned-bun.mjs";
import { createStateSchemaInlinePlugin } from "../../scripts/lib/state-schema-inline-plugin.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const directories = useAutoCleanupTempDirTracker(afterAll);
let runtimeUrl: string;

beforeAll(async () => {
  // The alias process must preserve symlinks without loading pnpm's source-loader
  // dependency layout. Bundle the real owner and its worker like an installed CLI.
  const runtime = directories.make("openclaw-retained-owner-");
  const schemas = createStateSchemaInlinePlugin();
  for (const [source, output] of [
    ["update-retained-runtime.ts", "retained-runtime.mjs"],
    ["update-candidate-state.worker.ts", "update-candidate-state.worker.mjs"],
  ] as const) {
    await build({
      entryPoints: [fileURLToPath(new URL(source, import.meta.url))],
      outfile: path.join(runtime, output),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["@openclaw/fs-safe", "@openclaw/fs-safe/*", "@resvg/resvg-js"],
      plugins: [
        {
          name: schemas.name,
          setup(bundle) {
            bundle.onLoad({ filter: /./ }, ({ path: modulePath }) => {
              const result = schemas.load.handler.call({ addWatchFile() {} }, modulePath);
              return result ? { contents: result.code, loader: result.moduleType } : undefined;
            });
          },
        },
      ],
      banner: {
        js: 'import { createRequire as createFixtureRequire } from "node:module"; const require = createFixtureRequire(import.meta.url);',
      },
      logLevel: "silent",
    });
  }
  const manifest = fileURLToPath(import.meta.resolve("@openclaw/fs-safe/package.json"));
  const require = createRequire(manifest);
  const copy = (source: string, name: string) =>
    fs.cp(path.dirname(source), path.join(runtime, "node_modules", name), {
      recursive: true,
      dereference: true,
    });
  await copy(manifest, "@openclaw/fs-safe");
  const metadata = JSON.parse(await fs.readFile(manifest, "utf8")) as {
    optionalDependencies: Record<string, string>;
  };
  for (const name of Object.keys(metadata.optionalDependencies)) {
    if (!name.startsWith("@openclaw/fs-safe-")) {
      continue;
    }
    let native: string;
    try {
      native = require.resolve(name + "/package.json");
    } catch {
      continue;
    }
    await copy(native, name);
  }
  runtimeUrl = pathToFileURL(path.join(runtime, "retained-runtime.mjs")).href;
});

for (const runtime of ["node", "bun", "node-alias", "node-short-path"] as const) {
  it.skipIf(
    (runtime === "bun" && process.platform === "win32") ||
      (runtime === "node-short-path" && process.platform !== "win32"),
  )(
    `keeps ${runtime} late imports on the old generation through replacement and CLI teardown`,
    async () => {
      const base = directories.make("openclaw-retained-imports-");
      const root = path.join(base, "install");
      const files = {
        "package.json": '{"name":"openclaw","type":"module"}',
        "node_modules/fixture/package.json": '{"type":"module","exports":"./index.js"}',
        "node_modules/fixture/index.js": 'export default "old dependency";',
        "node_modules/fixture-cjs/package.json": '{"type":"commonjs","exports":"./index.cjs"}',
        "node_modules/fixture-cjs/index.cjs":
          'module.exports = { value: "old CJS dependency", state: require("fixture-preloaded") };',
        "node_modules/fixture-preloaded/package.json":
          '{"type":"commonjs","exports":"./index.cjs"}',
        "node_modules/fixture-preloaded/index.cjs": 'module.exports = { state: "old singleton" };',
        "node_modules/fixture-commonjs-js/package.json":
          '{"type":"commonjs","exports":"./index.js"}',
        "node_modules/fixture-commonjs-js/index.js": 'exports.named = "old CommonJS JS";',
        "node_modules/fixture-conditional/package.json":
          '{"type":"module","exports":{"import":"./import.mjs","require":"./require.cjs"}}',
        "node_modules/fixture-conditional/import.mjs": 'export default "old import branch";',
        "node_modules/fixture-conditional/require.cjs": 'module.exports = "old require branch";',
        "dist/value.json": '{"value":"old JSON"}',
        "dist/json-baseline.json": '{"value":"baseline"}',
        "dist/json-baseline.mjs":
          'import data from "./json-baseline.json" with { type: "json" }; import { createRequire } from "node:module"; export const sharesIdentity = data === createRequire(import.meta.url)("./json-baseline.json");',
        "dist/shared.mjs": "export const shared = {};\n",
        "dist/late-old-hash.mjs":
          'import dependency from "fixture"; import conditional from "fixture-conditional"; import commonjs from "fixture-cjs"; import { named } from "fixture-commonjs-js"; import data from "./value.json" with { type: "json" }; import { existsSync } from "node:fs"; import { createRequire } from "node:module"; import path from "path"; import { shared } from "./shared.mjs"; const require = createRequire(import.meta.url); export { shared, commonjs, named, data, conditional }; export const requiredConditional = require("fixture-conditional"); export const required = require("fixture-cjs"); export const requiredJson = require("./value.json"); export const builtin = typeof existsSync === "function" && path.sep.length > 0; export const value = dependency; export const url = import.meta.url;',
        "dist/updater.mjs":
          'import { fileURLToPath } from "node:url"; import preloaded from "fixture-preloaded"; export { preloaded }; export const url = import.meta.url; export { shared } from "./shared.mjs"; export const late = () => import("./late-old-hash.mjs"); export const query = () => import("./late-old-hash.mjs?variant=1#x"); export const absolute = () => import(fileURLToPath(new URL("./absolute-old-hash.mjs", import.meta.url))); export const cleanup = () => import("./cleanup-old-hash.mjs");',
        "dist/absolute-old-hash.mjs": 'export const value = "old absolute";',
        "dist/cleanup-old-hash.mjs": 'export const value = "cleanup retained";',
        "dist/tool-dependency.mjs": 'export const value = "old tooling";',
        "tooling.mjs": 'export { value } from "./dist/tool-dependency.mjs";',
      };
      for (const [file, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(path.join(root, file), content);
      }
      let importRoot = root;
      if (runtime === "node-short-path") {
        const shortPath = spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/c", `for %I in ("${root}") do @echo %~sI`],
          // cmd.exe owns the command string rather than CRT argument quoting.
          { encoding: "utf8", windowsVerbatimArguments: true },
        );
        expect(shortPath.error, shortPath.stderr).toBeUndefined();
        expect(shortPath.status, shortPath.stderr).toBe(0);
        importRoot = shortPath.stdout.trim();
        expect(importRoot, "malformed 8.3 alias output").not.toMatch(/["\r\n]/);
        expect(path.isAbsolute(importRoot)).toBe(true);
        expect(importRoot, "8.3 alias unavailable on fixture volume").not.toBe(root);
        expect(await fs.realpath(importRoot)).toBe(await fs.realpath(root));
      } else if (runtime === "node-alias") {
        importRoot = path.join(base, "install-alias");
        await fs.symlink(root, importRoot, process.platform === "win32" ? "junction" : "dir");
      }
      const source = `import assert from "node:assert/strict";
     import fs from "node:fs/promises";
     import path from "node:path";
     import { pathToFileURL } from "node:url";
     import { withRetainedUpdateRuntime } from ${JSON.stringify(runtimeUrl)};
     const root = ${JSON.stringify(root)};
     const importRoot = ${JSON.stringify(importRoot)};
     const url = pathToFileURL(path.join(importRoot, "dist/updater.mjs")).href;
     const updater = await import(url);
     assert.equal(updater.url, url, "fixture must retain the requested module identity");
     const jsonBaseline = await import(pathToFileURL(path.join(root, "dist/json-baseline.mjs")).href);
     await withRetainedUpdateRuntime(url, async retain => {
       await retain({ mutationRoots: [root], timeoutMs: 30000, assertCurrent() {} });
       await fs.rm(path.join(root, "dist"), { recursive: true });
       await fs.mkdir(path.join(root, "dist"));
       await fs.writeFile(path.join(root, "dist/late-new-hash.mjs"), 'export const value = "new build";');
       await fs.writeFile(path.join(root, "dist/shared.mjs"), 'throw new Error("new singleton loaded by old updater");');
       await fs.writeFile(path.join(root, "dist/tool-dependency.mjs"), 'export const value = "new tooling";');
       for (const [file, content] of Object.entries({
         "fixture/index.js": 'export default "new dependency";',
         "fixture-cjs/index.cjs": 'module.exports = "new CJS dependency";',
         "fixture-commonjs-js/index.js": 'exports.named = "new CommonJS JS";',
         "fixture-preloaded/index.cjs": 'module.exports = { state: "new singleton" };',
         "fixture-conditional/import.mjs": 'export default "new import branch";',
         "fixture-conditional/require.cjs": 'module.exports = "new require branch";',
       })) {
         await fs.rm(path.join(root, "node_modules", file));
         await fs.writeFile(path.join(root, "node_modules", file), content);
       }
       const late = await updater.late();
       assert.equal(late.value, "old dependency");
       assert.equal(late.conditional, "old import branch");
       assert.equal(late.requiredConditional, "old require branch");
       assert.equal(late.commonjs.value, "old CJS dependency");
       assert.equal(late.named, "old CommonJS JS");
       assert.equal(late.commonjs, late.required);
       assert.equal(late.commonjs.state, updater.preloaded);
       assert.equal(late.data.value, "old JSON");
       assert.deepEqual(late.requiredJson, { value: "old JSON" });
       assert.equal(late.data === late.requiredJson, jsonBaseline.sharesIdentity);
       assert.equal(late.builtin, true);
       assert.equal(late.shared, updater.shared);
       assert.equal(late.url, pathToFileURL(path.join(importRoot, "dist/late-old-hash.mjs")).href);
       const queried = await updater.query();
       assert.equal(queried.value, "old dependency");
       assert.equal(queried.url, late.url + "?variant=1#x");
       assert.equal((await updater.absolute()).value, "old absolute");
       assert.equal((await import(pathToFileURL(path.join(root, "tooling.mjs")).href)).value, "new tooling");
     });
     assert.equal((await updater.cleanup()).value, "cleanup retained");
     assert.equal((await import(pathToFileURL(path.join(root, "dist/late-new-hash.mjs")).href)).value, "new build");`;
      const options = {
        encoding: "utf8" as const,
        input: "",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: base,
          TMPDIR: base,
          OPENCLAW_STATE_DIR: path.join(base, "state"),
          OPENCLAW_CONFIG_PATH: path.join(base, "state/openclaw.json"),
          XDG_CACHE_HOME: path.join(base, "cache"),
          OPENCLAW_LOG_LEVEL: "silent",
        },
      };
      const result =
        runtime !== "bun"
          ? spawnNodeEvalSync(source, {
              ...options,
              execArgv: runtime === "node-alias" ? ["--preserve-symlinks"] : [],
            })
          : spawnSync(requirePinnedBun(), ["--eval", source], options);
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    },
  );
}
