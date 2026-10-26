import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { requirePinnedBun } from "../../scripts/lib/pinned-bun.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const directories = useAutoCleanupTempDirTracker(afterAll);

for (const runtime of ["node", "bun"] as const) {
  it.skipIf(runtime === "bun" && process.platform === "win32")(
    `keeps ${runtime} late imports on the old generation through replacement and CLI teardown`,
    async () => {
      const base = directories.make("openclaw-retained-imports-");
      const root = path.join(base, "install");
      await fs.mkdir(path.join(root, "dist"), { recursive: true });
      await fs.mkdir(path.join(root, "node_modules", "fixture"), { recursive: true });
      await fs.mkdir(path.join(root, "node_modules", "fixture-cjs"), { recursive: true });
      await fs.mkdir(path.join(root, "node_modules", "fixture-commonjs-js"), { recursive: true });
      await fs.mkdir(path.join(root, "node_modules", "fixture-preloaded"), { recursive: true });
      await fs.mkdir(path.join(root, "node_modules", "fixture-conditional"), { recursive: true });
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
          'import { fileURLToPath } from "node:url"; import preloaded from "fixture-preloaded"; export { preloaded }; export { shared } from "./shared.mjs"; export const late = () => import("./late-old-hash.mjs"); export const query = () => import("./late-old-hash.mjs?variant=1#x"); export const absolute = () => import(fileURLToPath(new URL("./absolute-old-hash.mjs", import.meta.url))); export const cleanup = () => import("./cleanup-old-hash.mjs");',
        "dist/absolute-old-hash.mjs": 'export const value = "old absolute";',
        "dist/cleanup-old-hash.mjs": 'export const value = "cleanup retained";',
        "dist/tool-dependency.mjs": 'export const value = "old tooling";',
        "tooling.mjs": 'export { value } from "./dist/tool-dependency.mjs";',
      };
      for (const [file, content] of Object.entries(files)) {
        await fs.writeFile(path.join(root, file), content);
      }
      const source = `import assert from "node:assert/strict";
     import fs from "node:fs/promises";
     import path from "node:path";
     import { pathToFileURL } from "node:url";
     import { withRetainedUpdateRuntime } from ${JSON.stringify(new URL("./update-retained-runtime.ts", import.meta.url).href)};
     const root = ${JSON.stringify(root)};
     const url = pathToFileURL(path.join(root, "dist/updater.mjs")).href;
     const updater = await import(url);
     const jsonBaseline = await import(pathToFileURL(path.join(root, "dist/json-baseline.mjs")).href);
     await withRetainedUpdateRuntime(url, async retain => {
       await retain({ mutationRoots: [root], timeoutMs: 30000, assertCurrent() {} });
       await fs.rm(path.join(root, "dist"), { recursive: true });
       await fs.mkdir(path.join(root, "dist"));
       await fs.writeFile(path.join(root, "dist/late-new-hash.mjs"), 'export const value = "new build";');
       await fs.writeFile(path.join(root, "dist/shared.mjs"), 'throw new Error("new singleton loaded by old updater");');
       await fs.writeFile(path.join(root, "dist/tool-dependency.mjs"), 'export const value = "new tooling";');
       await fs.rm(path.join(root, "node_modules/fixture/index.js"));
       await fs.writeFile(path.join(root, "node_modules/fixture/index.js"), 'export default "new dependency";');
       await fs.rm(path.join(root, "node_modules/fixture-cjs/index.cjs"));
       await fs.writeFile(path.join(root, "node_modules/fixture-cjs/index.cjs"), 'module.exports = "new CJS dependency";');
       await fs.rm(path.join(root, "node_modules/fixture-commonjs-js/index.js"));
       await fs.writeFile(path.join(root, "node_modules/fixture-commonjs-js/index.js"), 'exports.named = "new CommonJS JS";');
       await fs.rm(path.join(root, "node_modules/fixture-preloaded/index.cjs"));
       await fs.writeFile(path.join(root, "node_modules/fixture-preloaded/index.cjs"), 'module.exports = { state: "new singleton" };');
       await fs.rm(path.join(root, "node_modules/fixture-conditional/import.mjs"));
       await fs.rm(path.join(root, "node_modules/fixture-conditional/require.cjs"));
       await fs.writeFile(path.join(root, "node_modules/fixture-conditional/import.mjs"), 'export default "new import branch";');
       await fs.writeFile(path.join(root, "node_modules/fixture-conditional/require.cjs"), 'module.exports = "new require branch";');
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
       assert.equal(late.url, pathToFileURL(path.join(root, "dist/late-old-hash.mjs")).href);
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
          HOME: base,
          TMPDIR: base,
          OPENCLAW_STATE_DIR: path.join(base, "state"),
          OPENCLAW_CONFIG_PATH: path.join(base, "state/openclaw.json"),
          XDG_CACHE_HOME: path.join(base, "cache"),
          OPENCLAW_LOG_LEVEL: "silent",
        },
      };
      const result =
        runtime === "node"
          ? spawnNodeEvalSync(source, {
              ...options,
              imports: [new URL("../../scripts/tsx.mjs", import.meta.url).href],
            })
          : spawnSync(requirePinnedBun(), ["--eval", source], options);
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    },
  );
}
