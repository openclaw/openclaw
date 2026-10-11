import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { UPDATE_PRELOAD_IMPORTS_FILE } from "./update-retained-imports-contract.js";

const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), contents);
  }
}

it.skipIf(Boolean(process.versions.bun))(
  "keeps the updater's lazy imports on its own release after package replacement",
  async () => {
    const base = tempDirs.make("openclaw-retained-imports-");
    const install = path.join(base, "openclaw");
    await fs.mkdir(path.join(install, ".git"), { recursive: true });
    await writeFiles(install, {
      "package.json": '{"name":"openclaw","type":"module"}',
      "dist/updater.mjs": [
        'import { createRequire } from "node:module";',
        'import { inc } from "detect-dep";',
        'import { bump } from "./shared.mjs";',
        "bump();",
        "inc();",
        'export const singleton = createRequire(import.meta.url)("singleton-dep");',
        'export * as queried from "./shared.mjs?instance=1";',
        'export const later = () => import("./chunk-OLD1234.mjs");',
        'export const stable = () => import("./stable.mjs");',
        'export const absolute = () => import(new URL("./chunk-ABS1234.mjs", import.meta.url));',
      ].join("\n"),
      "dist/chunk-ABS1234.mjs": 'export const release = "old-absolute";',
      "dist/shared.mjs": "export let count = 0; export function bump() { return ++count; }",
      "dist/chunk-OLD1234.mjs": [
        'import { createRequire } from "node:module";',
        'import imported from "typeless-dep";',
        'import flipped from "flip-dep";',
        'import { inc } from "detect-dep";',
        'import esm from "esm-dep";',
        'import { bump } from "./shared.mjs";',
        'const cjs = createRequire(import.meta.url)("cjs-dep");',
        'const requiredEsm = createRequire(import.meta.url)("esm-req-dep");',
        'const requiredDetected = createRequire(import.meta.url)("detect-req-dep");',
        "export const singleton = cjs.singleton;",
        'export const required = createRequire(import.meta.url)("./shared.mjs");',
        'export * as queried from "./shared.mjs?instance=1";',
        "export const value = [bump(), cjs.value, imported.value, flipped.value, requiredEsm.value, requiredDetected.value, inc(), esm, import.meta.url];",
      ].join("\n"),
      "dist/stable.mjs": 'export const release = "old";',
      "node_modules/cjs-dep/package.json": '{"name":"cjs-dep","main":"index.js"}',
      "node_modules/cjs-dep/index.js":
        'module.exports = { value: require(require("node:path").join(__dirname, "nested.js")), singleton: require("singleton-dep") };',
      "node_modules/cjs-dep/nested.js": 'module.exports = "old-cjs";',
      "node_modules/esm-dep/package.json": '{"name":"esm-dep","type":"module","exports":"./i.js"}',
      "node_modules/esm-dep/i.js": 'export default "old-esm";',
      "node_modules/typeless-dep/package.json": '{"name":"typeless-dep","main":"index.js"}',
      "node_modules/typeless-dep/index.js": 'module.exports = { value: "old-typeless" };',
      "node_modules/singleton-dep/package.json": '{"name":"singleton-dep","main":"index.js"}',
      "node_modules/singleton-dep/index.js": "module.exports = {};",
      "node_modules/flip-dep/package.json": '{"name":"flip-dep","main":"index.js"}',
      "node_modules/flip-dep/index.js": 'module.exports = { value: "old-flip" };',
      "node_modules/esm-req-dep/package.json":
        '{"name":"esm-req-dep","type":"module","main":"index.js"}',
      "node_modules/esm-req-dep/index.js": 'export const value = "old-esm-req";',
      // Typeless ESM syntax: Node detects the format while loading.
      "node_modules/detect-dep/package.json": '{"name":"detect-dep","main":"index.js"}',
      "node_modules/detect-dep/index.js": "export let n = 0; export function inc() { return ++n; }",
      "node_modules/detect-req-dep/package.json": '{"name":"detect-req-dep","main":"index.js"}',
      "node_modules/detect-req-dep/index.js": 'export const value = "old-detect-req";',
    });
    const replacement = {
      "package.json": '{"name":"openclaw","type":"module"}',
      "dist/updater.mjs": 'export const later = () => import("./chunk-NEW5678.mjs");',
      "dist/shared.mjs": "export const count = -1;",
      "dist/chunk-NEW5678.mjs": "export const value = [];",
      "dist/stable.mjs": 'export const release = "new";',
      "node_modules/esm-dep/package.json": '{"name":"esm-dep","type":"module","exports":"./i.js"}',
      "node_modules/esm-dep/i.js": 'export default "new-esm";',
      // Required and imported dependencies switch module type, and typeless-dep
      // and detect-dep disappear.
      "node_modules/cjs-dep/package.json": '{"name":"cjs-dep","type":"module","main":"index.js"}',
      "node_modules/cjs-dep/index.js": 'export const value = "new-esm-cjs-dep";',
      "node_modules/flip-dep/package.json": '{"name":"flip-dep","type":"module","main":"index.js"}',
      "node_modules/flip-dep/index.js": 'export const value = "new-flip";',
      "node_modules/esm-req-dep/package.json":
        '{"name":"esm-req-dep","type":"commonjs","main":"index.js"}',
      "node_modules/esm-req-dep/index.js": 'module.exports = { value: "new-esm-req" };',
      "node_modules/detect-req-dep/package.json":
        '{"name":"detect-req-dep","type":"commonjs","main":"index.js"}',
      "node_modules/detect-req-dep/index.js": 'module.exports = { value: "new-detect-req" };',
    };
    const result = spawnNodeEvalSync(
      `import assert from "node:assert/strict";
       import fs from "node:fs";
       import path from "node:path";
       import { pathToFileURL } from "node:url";
       import { withRetainedUpdateRuntime } from ${JSON.stringify(new URL("./update-retained-runtime.ts", import.meta.url).href)};
       const install = ${JSON.stringify(install)};
       const updaterUrl = pathToFileURL(path.join(install, "dist/updater.mjs")).href;
       const { later, stable, absolute, singleton, queried } = await import(updaterUrl);
       await withRetainedUpdateRuntime(updaterUrl, async (retain) => {
         const metrics = await retain({ mutationRoots: [install], timeoutMs: 30000, assertCurrent() {} });
         assert.equal(metrics.retainedImports, true);
         // Replace the package the way activation does: old hashed chunks and
         // dependencies disappear, stable names carry candidate bytes.
         fs.rmSync(path.join(install, "dist"), { recursive: true });
         fs.rmSync(path.join(install, "node_modules"), { recursive: true });
         for (const [name, contents] of Object.entries(${JSON.stringify(replacement)})) {
           fs.mkdirSync(path.dirname(path.join(install, name)), { recursive: true });
           fs.writeFileSync(path.join(install, name), contents);
         }
         const chunk = await later();
         const [count, cjs, imported, flipped, requiredEsm, requiredDetected, detected, esm, url] =
           chunk.value;
         // A retained CommonJS module joins dependencies cached before replacement.
         assert.equal(chunk.singleton, singleton);
         // Required and query-suffixed ES modules keep their installed identities.
         assert.equal(chunk.required, await import(pathToFileURL(path.join(install, "dist/shared.mjs")).href));
         assert.equal(chunk.queried, queried);
         assert.deepEqual(
           [cjs, imported, flipped, requiredEsm, requiredDetected, esm],
           ["old-cjs", "old-typeless", "old-flip", "old-esm-req", "old-detect-req", "old-esm"],
         );
         assert.equal(url, pathToFileURL(path.join(install, "dist/chunk-OLD1234.mjs")).href);
         // The chunk joined the module instances loaded before replacement.
         assert.equal(detected, 2);
         assert.equal(count, 2);
         assert.equal((await import(pathToFileURL(path.join(install, "dist/shared.mjs")).href)).count, 2);
         assert.equal((await stable()).release, "old");
         assert.equal((await absolute()).release, "old-absolute");
       });
       console.log("retained imports verified");`,
      {
        // tsx/esm leaves CommonJS on the native loader, as in a built install.
        imports: [import.meta.resolve("tsx/esm")],
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
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("retained imports verified");
  },
);

// Bun has no module hooks: its updater preloads the build-listed chunks before
// replacement. Without the list, the same lazy import reaches the replaced tree.
it.skipIf(!bunAvailable).each([
  { listed: true, expected: "old:old-dep:1" },
  { listed: false, expected: "ENOENT" },
])("Bun updater preloads its later imports (listed=$listed)", async ({ listed, expected }) => {
  const base = tempDirs.make("openclaw-retained-preload-");
  const install = path.join(base, "openclaw");
  await fs.mkdir(path.join(install, ".git"), { recursive: true });
  await writeFiles(install, {
    "package.json": '{"name":"openclaw","type":"module"}',
    "dist/updater.mjs": [
      'import { bump } from "./shared.mjs";',
      "bump();",
      'export const later = () => import("./chunk-OLD1234.mjs");',
    ].join("\n"),
    "dist/shared.mjs": "export let count = 0; export function bump() { return ++count; }",
    "dist/chunk-OLD1234.mjs": [
      'import { count } from "./shared.mjs";',
      'import dep from "esm-dep";',
      'export const value = () => ["old", dep, count].join(":");',
    ].join("\n"),
    "node_modules/esm-dep/package.json": '{"name":"esm-dep","type":"module","exports":"./i.js"}',
    "node_modules/esm-dep/i.js": 'export default "old-dep";',
    ...(listed
      ? { [`dist/${UPDATE_PRELOAD_IMPORTS_FILE}`]: '{"chunks":["chunk-OLD1234.mjs"]}' }
      : {}),
  });
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import { withRetainedUpdateRuntime } from ${JSON.stringify(new URL("./update-retained-runtime.ts", import.meta.url).href)};
    const install = ${JSON.stringify(install)};
    const updaterUrl = pathToFileURL(path.join(install, "dist/updater.mjs")).href;
    const { later } = await import(updaterUrl);
    await withRetainedUpdateRuntime(updaterUrl, async (retain) => {
      const metrics = await retain({ mutationRoots: [install], timeoutMs: 30000, assertCurrent() {} });
      console.log("retainedImports=" + metrics.retainedImports);
      // Replacement removes the old hashed chunk and its dependency.
      fs.rmSync(path.join(install, "dist"), { recursive: true });
      fs.rmSync(path.join(install, "node_modules"), { recursive: true });
      fs.mkdirSync(path.join(install, "dist"));
      fs.writeFileSync(path.join(install, "dist/chunk-NEW5678.mjs"), "export const value = () => 'new';");
      try {
        console.log("result=" + (await later()).value());
      } catch (error) {
        console.log("result=" + (error.code ?? error.message));
      }
    });`;
  const result = spawnSync("bun", ["--eval", script], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: base,
      TMPDIR: base,
      OPENCLAW_STATE_DIR: path.join(base, "state"),
      OPENCLAW_CONFIG_PATH: path.join(base, "state/openclaw.json"),
      XDG_CACHE_HOME: path.join(base, "cache"),
      OPENCLAW_LOG_LEVEL: "silent",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`retainedImports=${listed}`);
  expect(result.stdout).toContain(`result=${expected}`);
});
