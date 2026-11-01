import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { standaloneEmbeddedPathsExpression } from "../../scripts/lib/bun-standalone-data.mjs";
import { rewriteStandaloneImports } from "../../scripts/lib/bun-standalone-imports.mjs";
import { createStandaloneNativeAdapter } from "../../scripts/lib/bun-standalone-native.mjs";
import { stageStandalonePluginLoader } from "../../scripts/lib/bun-standalone-plugins.mjs";
import {
  createStandaloneExternalModuleBootstrap,
  createStandaloneModuleResolverBootstrap,
  createStandaloneRequireAdapter,
} from "../../scripts/lib/bun-standalone-require.mjs";
import {
  planStandaloneRuntime,
  pruneStandaloneRuntime,
} from "../../scripts/lib/bun-standalone-sidecar.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

const configuredBun = process.env.OPENCLAW_BUN_PATH?.trim();
const bunCommand = configuredBun || "bun";
// Explicit compilers are exercised by the fixtures; probing cannot change admission.
const hasBun =
  Boolean(configuredBun) || spawnSync(bunCommand, ["--version"], { timeout: 10_000 }).status === 0;

// Node-only test jobs do not provision Bun; an explicit compiler override must work.
it.skipIf(!hasBun)("keeps retained loader bytes independent of the staging directory", async () => {
  const root = temporary.make("standalone-plugin-loader-bytes-");
  const outputs: Buffer[] = [];
  for (const name of ["first", "second"]) {
    const outputRoot = path.join(root, name);
    const runtimeRoot = path.join(outputRoot, "runtime");
    const jitiRoot = path.join(runtimeRoot, "node_modules/jiti");
    fs.mkdirSync(jitiRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "package.json"), '{"name":"openclaw"}');
    fs.writeFileSync(path.join(jitiRoot, "package.json"), '{"name":"jiti","main":"index.cjs"}');
    fs.writeFileSync(path.join(jitiRoot, "LICENSE"), "fixture license");
    fs.writeFileSync(path.join(jitiRoot, "index.cjs"), "exports.createJiti = () => 42;");
    const loader = await stageStandalonePluginLoader({
      runtimeRoot,
      outputRoot,
      build: async (options) => {
        const result = spawnSync(
          bunCommand,
          [
            "--eval",
            'const result = await Bun.build(JSON.parse(process.argv.at(-1))); if (!result.success) throw new AggregateError(result.logs, "Loader bundle failed");',
            JSON.stringify(options),
          ],
          { cwd: root, encoding: "utf8", timeout: 10_000 },
        );
        expect(result.status, result.stderr).toBe(0);
        return { success: true, logs: [] };
      },
    });
    outputs.push(fs.readFileSync(path.join(runtimeRoot, loader.modulePath)));
  }
  expect(outputs[0]).toEqual(outputs[1]);
});

it.each(["jit", "bytecode", "aot"])(
  "keeps native plugin loading and transforms lazy after relocation (%s)",
  async (mode) => {
    const root = temporary.make("standalone-plugin-loader-");
    const artifact = path.join(root, "artifact");
    const runtimeRoot = path.join(artifact, "runtime");
    const jitiRoot = path.join(runtimeRoot, "node_modules/jiti");
    fs.mkdirSync(jitiRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "package.json"), '{"name":"openclaw"}');
    fs.writeFileSync(path.join(jitiRoot, "package.json"), '{"name":"jiti","main":"index.cjs"}');
    fs.writeFileSync(path.join(jitiRoot, "LICENSE"), "fixture license");
    fs.writeFileSync(
      path.join(jitiRoot, "index.cjs"),
      `globalThis.fixtureLoaderEvaluations = (globalThis.fixtureLoaderEvaluations ?? 0) + 1;
exports.createJiti = () => require("node:querystring").parse("result=fixture%20factory").result;`,
    );
    const loader = await stageStandalonePluginLoader({
      runtimeRoot,
      outputRoot: artifact,
      build: async (options) => {
        const result = await build({
          entryPoints: options.entrypoints,
          outdir: options.outdir,
          entryNames: "index",
          outExtension: { ".js": ".cjs" },
          platform: "node",
          format: options.format,
          bundle: true,
        });
        return { success: true, logs: result.warnings };
      },
    });
    const adapter = createStandaloneRequireAdapter({
      runtimeRoot,
      embeddedPaths: {},
      pluginLoader: loader,
    });
    const nativeAdapter = createStandaloneNativeAdapter({ runtimeRoot, parse });
    nativeAdapter.discover([loader.modulePath]);
    expect(nativeAdapter.builtinModules).toEqual(["node:module", "node:querystring"]);
    const builtins = adapter.finalize(nativeAdapter.builtinModules);
    fs.writeFileSync(path.join(artifact, "plugin.cjs"), "module.exports = { value: 42 };");
    fs.writeFileSync(
      path.join(artifact, "embedded.cjs"),
      'module.exports = { value: "embedded" };',
    );
    expect(fs.existsSync(path.join(artifact, "plugin-loader-entry.cjs"))).toBe(false);
    fs.writeFileSync(
      path.join(artifact, "bootstrap.mjs"),
      `import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("./runtime/", import.meta.url));
const imageEntry = path.join(path.dirname(root), "embedded.cjs");
const embedded = (filename) => filename === imageEntry ? imageEntry : undefined;
const commonJsEntries = new Set();
globalThis.__openclawStandaloneNativeResolve = () => undefined;
globalThis.__openclawStandaloneBuildInfo = Object.freeze({ mode: ${JSON.stringify(mode)} });
const resolveFilename = Module._resolveFilename;
${adapter.bootstrap.replace(builtins.search, builtins.replacement)}
assert.equal(Module._resolveFilename, resolveFilename);
assert.equal(globalThis.fixtureLoaderEvaluations, undefined);
const native = globalThis.__openclawStandaloneCreateRequire(createRequire, import.meta.url);
const loaderPath = path.join(root, "node_modules/@openclaw/plugin-loader/index.cjs");
assert.equal(native.cache[loaderPath], undefined);
assert.equal(native(imageEntry).value, "embedded");
assert.equal(native.cache[loaderPath], undefined);
assert.deepEqual(native("./plugin.cjs"), { value: 42 });
assert.equal(native("./plugin.cjs"), native("./plugin.cjs"));
assert.equal(globalThis.fixtureLoaderEvaluations, undefined);
const first = globalThis.openclawStandaloneLoadJitiFactory();
assert.equal(globalThis.fixtureLoaderEvaluations, undefined);
assert.equal(first(), "fixture factory");
assert.equal(globalThis.openclawStandaloneLoadJitiFactory(), first);
assert.equal(globalThis.fixtureLoaderEvaluations, 1);
console.log("lazy relocated loader");`,
    );
    const plan = planStandaloneRuntime(runtimeRoot, loader.files);
    expect(plan.pruning.categories).toMatchObject({ pluginLoader: { files: 3 } });
    pruneStandaloneRuntime(plan);
    const moved = path.join(root, "relocated");
    fs.renameSync(artifact, moved);
    expect(fs.existsSync(path.join(moved, "runtime/node_modules/jiti"))).toBe(false);
    expect(
      fs.readFileSync(
        path.join(moved, "runtime/node_modules/@openclaw/plugin-loader/LICENSE"),
        "utf8",
      ),
    ).toBe("fixture license");
    const result = spawnSync(process.execPath, [path.join(moved, "bootstrap.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("lazy relocated loader");
  },
);

it.skipIf(process.platform === "win32" || !hasBun)(
  "keeps compiled SDK exports and disk CommonJS identity across image and plugin imports",
  () => {
    const root = temporary.make("standalone-image-exports-");
    const sdk = path.join(root, "sdk.mjs");
    const legacy = path.join(root, "legacy.cjs");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
    fs.writeFileSync(
      sdk,
      "globalThis.sdkLoads = (globalThis.sdkLoads ?? 0) + 1; export function answer() { return 42; } export default { name: 'sdk' };\n",
    );
    fs.writeFileSync(
      legacy,
      "globalThis.legacyLoads = (globalThis.legacyLoads ?? 0) + 1; module.exports = () => 'legacy';\n",
    );
    fs.writeFileSync(
      path.join(root, "consumer.cjs"),
      `module.exports = { sdk: require("fixture-sdk"), legacy: require("fixture-legacy") };`,
    );
    const consumer = path.join(root, "consumer.mjs");
    fs.writeFileSync(
      consumer,
      `import { answer } from ${JSON.stringify(pathToFileURL(sdk).href)};
import { createRequire } from "node:module";
export const esmAnswer = answer();
export const cjs = createRequire(import.meta.url)("./consumer.cjs");`,
    );
    const image = "/$bunfs/root/sdk.mjs";
    const embeddedPaths = { "sdk.mjs": image, "legacy.cjs": legacy };
    const native = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    native.discover(["sdk.mjs"]);
    const resources = native.finalize({ metafile: { inputs: {} }, embeddedPaths });
    const adapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths });
    const builtins = adapter.finalize(native.builtinModules);
    const resolver = rewriteStandaloneImports({
      contents: `Module._resolveFilename = (specifier, ...args) => specifier === "fixture-sdk" ? sdk : specifier === "fixture-legacy" ? legacy : original(specifier, ...args);`,
      filename: path.join(root, "main.mjs"),
      runtimeRoot: root,
      embeddedPaths,
      moduleAliases: {},
      workerThreadsShim: "",
      parse,
    });
    const main = path.join(root, "main.mjs");
    fs.writeFileSync(
      main,
      `import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
const root = ${JSON.stringify(root)};
const sdk = ${JSON.stringify(sdk)};
const legacy = ${JSON.stringify(legacy)};
const commonJsEntries = new Set([legacy]);
const entries = ${standaloneEmbeddedPathsExpression(embeddedPaths)};
function embedded(filename) {
  return entries(filename) ?? entries(path.relative(root, filename).split(path.sep).join("/"));
}
${native.bootstrap.replace(resources.bootstrapReplacement.search, resources.bootstrapReplacement.replacement)}
${adapter.bootstrap.replace(builtins.search, builtins.replacement)}
${createStandaloneExternalModuleBootstrap({ source: true })}
${createStandaloneModuleResolverBootstrap()}
const original = Module._resolveFilename;
${resolver}
const nativeRequire = globalThis.__openclawStandaloneCreateRequire(createRequire, import.meta.url);
nativeRequire.resolve("fixture-sdk");
assert.equal(globalThis.sdkLoads, undefined);
const internal = await import(embedded(sdk));
assert.equal(internal.answer(), 42);
const legacyModule = nativeRequire(legacy);
assert.equal(legacyModule(), "legacy");
const external = await import(process.env.FIXTURE_CONSUMER);
assert.equal(external.esmAnswer, 42);
assert.equal(external.cjs.sdk.answer(), 42);
assert.equal(external.cjs.sdk.answer, internal.answer);
assert.equal(external.cjs.sdk.default.name, "sdk");
assert.equal(external.cjs.sdk.default, internal.default);
assert.equal(external.cjs.legacy, legacyModule);
assert.equal(await import(process.env.FIXTURE_CONSUMER), external);
assert.equal(globalThis.sdkLoads, 1);
assert.equal(globalThis.legacyLoads, 1);
console.log("image and external exports preserved");`,
    );
    const executable = path.join(root, "program");
    const compiled = spawnSync(
      bunCommand,
      [
        "--eval",
        'const result = await Bun.build(JSON.parse(process.argv.at(-1))); if (!result.success) throw new AggregateError(result.logs, "Fixture compile failed");',
        JSON.stringify({
          root,
          entrypoints: [main, sdk],
          target: "bun",
          format: "esm",
          compile: { outfile: executable },
        }),
      ],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    expect(compiled.status, compiled.stderr).toBe(0);
    fs.unlinkSync(sdk);
    const result = spawnSync(executable, [], {
      cwd: root,
      env: { ...process.env, FIXTURE_CONSUMER: pathToFileURL(consumer).href },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("image and external exports preserved");
  },
);
