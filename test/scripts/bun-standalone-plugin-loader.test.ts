import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { parse } from "acorn";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { standaloneEmbeddedPathsExpression } from "../../scripts/lib/bun-standalone-data.mjs";
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
import { runStandaloneBootstrap } from "../helpers/standalone-bootstrap.js";
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
    expect(nativeAdapter.builtinModules).toEqual([]);
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
import.meta.require = createRequire(import.meta.url);
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

it.each(["path", "resolution"])("loads shared image exports lazily (%s)", (first) => {
  const root = temporary.make("standalone-image-boundary-");
  const esm = "/$bunfs/root/new-sdk.mjs";
  const cjs = "/$bunfs/root/new-legacy.cjs";
  const state = { count: 0 };
  const sdk = { state, increment: () => ++state.count, default: state };
  const legacy = Object.assign(() => "legacy", { state });
  const exports = new Map<string, unknown>([
    [esm, sdk],
    [cjs, legacy],
  ]);
  const embeddedPaths: Record<string, string> = { "new-sdk.mjs": esm, "new-legacy.cjs": cjs };
  const adapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths });
  const builtins = adapter.finalize([]);
  let load: ((args: { path: string }) => { exports: Record<string, unknown> }) | undefined;
  let registrations = 0;
  const builder = {
    onLoad(_options: unknown, callback: NonNullable<typeof load>) {
      load = callback;
    },
  };
  const context = vm.createContext({
    root,
    path,
    fileURLToPath,
    createRequire,
    commonJsEntries: new Set([cjs]),
    embedded: (filename: string) =>
      exports.has(filename) ? filename : embeddedPaths[path.relative(root, filename)],
    __openclawStandaloneNativeResolve: () => undefined,
    Bun: {
      plugin(options: { setup: (value: typeof builder) => void }) {
        registrations++;
        options.setup(builder);
      },
    },
  });
  const imageRequire = (specifier: string) => {
    if (!exports.has(specifier)) {
      throw new Error(`Unexpected image import: ${specifier}`);
    }
    return exports.get(specifier);
  };
  runStandaloneBootstrap(
    adapter.bootstrap.replace(builtins.search, builtins.replacement),
    context,
    imageRequire,
  );
  runStandaloneBootstrap(createStandaloneExternalModuleBootstrap(), context, imageRequire);
  expect(registrations).toBe(0);
  const missing = path.join(root, "missing.mjs");
  expect(context["__openclawStandaloneExternalModulePath"](missing)).toBeUndefined();
  expect(context["__openclawStandaloneExternalModuleResolution"](missing)).toEqual({
    path: missing,
    namespace: "file",
  });
  expect(registrations).toBe(0);
  const require = context["__openclawStandaloneCreateRequire"](
    createRequire,
    path.join(root, "consumer.cjs"),
  );
  // No corresponding files exist on disk: a new image edge must use the image intrinsic.
  expect(require(path.join(root, "new-sdk.mjs"))).toBe(sdk);
  expect(require(path.join(root, "new-legacy.cjs"))).toBe(legacy);
  expect(registrations).toBe(0);
  const imagePath = path.join(root, "new-sdk.mjs");
  if (first === "path") {
    expect(context["__openclawStandaloneExternalModulePath"](imagePath)).toBe(
      `openclaw-image:${esm}`,
    );
  } else {
    expect(context["__openclawStandaloneExternalModuleResolution"](imagePath)).toEqual({
      path: esm,
      namespace: "openclaw-image",
    });
  }
  context["__openclawStandaloneExternalModulePath"](imagePath);
  context["__openclawStandaloneExternalModuleResolution"](imagePath);
  expect(registrations).toBe(1);
  expect(load).toBeTypeOf("function");
  expect(load!({ path: esm }).exports.increment).toBe(sdk.increment);
  expect(load!({ path: esm }).exports.default).toBe(state);
  expect(load!({ path: cjs }).exports.default).toBe(legacy);
  expect(load!({ path: cjs }).exports.state).toBe(state);
});

it.skipIf(process.platform === "win32" || !hasBun)(
  "keeps compiled SDK and callable CommonJS identity for disk CJS, ESM and TypeScript plugins",
  () => {
    const root = temporary.make("standalone-image-exports-");
    const sdk = path.join(root, "sdk.mjs");
    const legacy = path.join(root, "legacy.cjs");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "openclaw",
        type: "module",
        exports: { "./plugin-sdk/fixture": "./sdk.mjs", "./plugin-sdk/legacy": "./legacy.cjs" },
      }),
    );
    fs.writeFileSync(
      sdk,
      "globalThis.sdkLoads = (globalThis.sdkLoads ?? 0) + 1; export const state = { count: 0 }; export function answer() { return ++state.count; } export default state;\n",
    );
    fs.writeFileSync(
      legacy,
      "globalThis.legacyLoads = (globalThis.legacyLoads ?? 0) + 1; module.exports = Object.assign(() => 'legacy', { tag: 'callable' });\n",
    );
    fs.writeFileSync(
      path.join(root, "consumer.cjs"),
      `module.exports = { sdk: require("openclaw/plugin-sdk/fixture"), legacy: require("openclaw/plugin-sdk/legacy") };`,
    );
    const consumers = ["mjs", "ts"].map((extension) => {
      const filename = path.join(root, `consumer.${extension}`);
      fs.writeFileSync(
        filename,
        `import sdk, { answer, state } from "openclaw/plugin-sdk/fixture";
import legacy from "openclaw/plugin-sdk/legacy";
import { createRequire } from "node:module";
export const typed${extension === "ts" ? ": number" : ""} = 42;
export { sdk, answer, state, legacy };
export const cjs = createRequire(import.meta.url)("./consumer.cjs");`,
      );
      return pathToFileURL(filename).href;
    });
    const embeddedPaths = {
      "sdk.mjs": "/$bunfs/root/sdk.mjs",
      "legacy.cjs": "/$bunfs/root/legacy.cjs",
    };
    const native = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    native.discover(["sdk.mjs", "legacy.cjs"]);
    const resources = native.finalize({ metafile: { inputs: {} }, embeddedPaths });
    const adapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths });
    const builtins = adapter.finalize(native.builtinModules);
    const main = path.join(root, "main.mjs");
    fs.writeFileSync(
      main,
      `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
const root = ${JSON.stringify(root)};
const commonJsEntries = new Set([${JSON.stringify(embeddedPaths["legacy.cjs"])}]);
const entries = ${standaloneEmbeddedPathsExpression(embeddedPaths)};
function embedded(filename) { return entries(filename) ?? entries(path.relative(root, filename).split(path.sep).join("/")); }
${native.bootstrap.replace(resources.bootstrapReplacement.search, resources.bootstrapReplacement.replacement)}
${adapter.bootstrap.replace(builtins.search, builtins.replacement)}
${createStandaloneExternalModuleBootstrap()}
${createStandaloneModuleResolverBootstrap()}
const nativeRequire = globalThis.__openclawStandaloneCreateRequire(createRequire, path.join(root, "package.json"));
nativeRequire.resolve("openclaw/plugin-sdk/fixture");
assert.equal(globalThis.sdkLoads, undefined);
const internal = await import(embedded(${JSON.stringify(sdk)}));
const legacyModule = nativeRequire(${JSON.stringify(legacy)});
assert.equal(legacyModule(), "legacy");
assert.equal(legacyModule.tag, "callable");
for (const filename of JSON.parse(process.env.FIXTURE_CONSUMERS)) {
  const external = await import(filename);
  assert.equal(await import(filename), external);
  assert.equal(external.typed, 42);
  assert.equal(external.state, internal.state);
  assert.equal(external.answer, internal.answer);
  assert.equal(external.sdk, internal.default);
  assert.equal(external.cjs.sdk.answer, internal.answer);
  assert.equal(external.cjs.sdk.default, internal.default);
  assert.equal(external.legacy, legacyModule);
  assert.equal(external.cjs.legacy, legacyModule);
  const previous = internal.state.count;
  external.answer();
  assert.equal(internal.state.count, previous + 1);
}
assert.equal(globalThis.sdkLoads, 1);
assert.equal(globalThis.legacyLoads, 1);
console.log("image and external exports preserved");`,
    );
    const executable = path.join(root, "program");
    // Explicit qualification runs use an AOT-capable compiler; normal CI keeps pinned Bun.
    const aot = process.env.OPENCLAW_TEST_BUN_AOT === "1";
    const compiled = spawnSync(
      bunCommand,
      [
        "--eval",
        'const result = await Bun.build(JSON.parse(process.argv.at(-1))); if (!result.success) throw new AggregateError(result.logs, "Fixture compile failed");',
        JSON.stringify({
          root,
          entrypoints: [main, sdk, legacy],
          target: "bun",
          format: "esm",
          compile: {
            outfile: executable,
            ...(aot
              ? {
                  aot: true,
                  allowCodeFromDisk: true,
                  functionSource: false,
                  disallowCodeGenerationFromStrings: true,
                  trim: { allow: ["run", "interpreter"] },
                }
              : {}),
          },
        }),
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    expect(compiled.status, compiled.stderr).toBe(0);
    fs.unlinkSync(sdk);
    fs.unlinkSync(legacy);
    const result = spawnSync(executable, [], {
      cwd: root,
      env: { ...process.env, FIXTURE_CONSUMERS: JSON.stringify(consumers) },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("image and external exports preserved");
  },
);
