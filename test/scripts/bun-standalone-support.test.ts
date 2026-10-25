import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneArtifactAdapter } from "../../scripts/lib/bun-standalone-artifacts.mjs";
import {
  planStandaloneRuntime,
  pruneStandaloneRuntime,
} from "../../scripts/lib/bun-standalone-sidecar.mjs";
import { createStandaloneSourceEntries } from "../../scripts/lib/bun-standalone-source-entries.mjs";
import { createStandaloneSourceGraph } from "../../scripts/lib/bun-standalone-source-graph.mjs";
import { standaloneSourceGraphSha256 } from "../../scripts/lib/bun-standalone-source-identity.mjs";
import {
  assertStandaloneDestinations,
  compileStandaloneArtifacts,
  describeStandaloneNativeModules,
  publishStandaloneArtifacts,
  STANDALONE_BUILD_MARKER,
} from "../../scripts/lib/bun-standalone-support.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(failSupport = false) {
  const root = tempDirs.make("standalone-support-");
  const outputRoot = path.join(root, "staging");
  const compileRoot = path.join(outputRoot, "modules");
  const runtimeRoot = path.join(outputRoot, "runtime");
  fs.mkdirSync(compileRoot, { recursive: true });
  fs.mkdirSync(runtimeRoot);
  fs.writeFileSync(path.join(runtimeRoot, "asset.txt"), "same resource\n");
  fs.symlinkSync("asset.txt", path.join(runtimeRoot, "asset-link"));
  fs.writeFileSync(
    path.join(runtimeRoot, "openclaw.mjs"),
    `import { spawnSync } from "node:child_process";
import { getStandaloneRuntimeBuild, resolveOpenClawCliRespawn } from "./cli-invocation.mjs";
import { answer } from "./leaf.mjs";
if (!process.argv.includes("--debug-child")) {
  const launch = resolveOpenClawCliRespawn({ args: ["--debug-child"] });
  const child = spawnSync(launch.command, launch.args, { encoding: "utf8", env: launch.env });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  process.exit(child.status ?? 1);
}
console.log(JSON.stringify({ answer, mode: getStandaloneRuntimeBuild()?.mode ?? null, sqliteLibrary: process.env.OPENCLAW_SQLITE_LIBRARY ?? null }));`,
  );
  for (const filename of [
    "cli-invocation.mjs",
    "cli-parent-lifetime.mjs",
    "gateway-shutdown-budget.mjs",
    "node-runtime-env.mjs",
  ]) {
    fs.copyFileSync(
      new URL(`../../${filename}`, import.meta.url),
      path.join(runtimeRoot, filename),
    );
  }
  fs.mkdirSync(path.join(runtimeRoot, "lib"));
  fs.writeFileSync(path.join(runtimeRoot, "lib/test-sqlite.dylib"), "synthetic SQLite library");
  fs.writeFileSync(path.join(runtimeRoot, "leaf.mjs"), "export const answer = 42;");
  fs.writeFileSync(path.join(runtimeRoot, "leaf.mjs.map"), '{"version":3}');
  fs.mkdirSync(path.join(runtimeRoot, "node_modules"));
  fs.symlinkSync("../extensions/matrix", path.join(runtimeRoot, "node_modules/matrix"));
  const mainEntry = path.join(compileRoot, "main.js");
  const source = `globalThis.__openclawStandaloneBuildInfo = ${JSON.stringify(STANDALONE_BUILD_MARKER)};\n`;
  fs.writeFileSync(mainEntry, source);
  fs.writeFileSync(`${mainEntry}.map`, '{"version":3,"sources":["original.ts"]}');
  const compiler = path.join(root, "compiler");
  fs.writeFileSync(
    compiler,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (require('node:path').basename(args[0]) === 'compile-aot.mjs') {
  const compiler = {build: async (options) => {
    fs.writeFileSync(options.compile.outfile, JSON.stringify({aot: true, source: fs.readFileSync(options.entrypoints[0], 'utf8')}));
    fs.writeFileSync(__filename + '.options.json', JSON.stringify(options));
    return {success: true, logs: []};
  }};
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  new AsyncFunction('Bun', fs.readFileSync(args[0], 'utf8'))(compiler).catch((error) => {console.error(error); process.exitCode = 1;});
  return;
}
if (args[0] !== 'build') {
  const result = require('node:child_process').spawnSync(process.execPath, args, {stdio:'inherit'});
  process.exit(result.status ?? 1);
}
if (${failSupport} && !args.includes('--aot')) process.exit(42);
const output = args.find((arg) => arg.startsWith('--outfile=')).slice(10);
fs.writeFileSync(output, JSON.stringify({aot: args.includes('--aot'), source: fs.readFileSync('main.js', 'utf8')}));
`,
    { mode: 0o755 },
  );
  return { root, outputRoot, compileRoot, runtimeRoot, mainEntry, source, compiler };
}

function compileOptions(
  input: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof compileStandaloneArtifacts>[0]> = {},
): Parameters<typeof compileStandaloneArtifacts>[0] {
  return {
    runtimeRoot: input.runtimeRoot,
    outputRoot: input.outputRoot,
    destination: path.join(input.root, "aot"),
    supportDestination: path.join(input.root, "support"),
    mode: "aot",
    compileFlags: ["--aot"],
    compileRoot: input.compileRoot,
    compileCwd: input.compileRoot,
    mainEntry: input.mainEntry,
    compiledEntries: [input.mainEntry],
    compileEntries: new Set([input.mainEntry]),
    external: [],
    bunExecutable: input.compiler,
    bun: { version: "1.4.4", revision: "fixture" },
    openclaw: { version: "2026.10.3", commit: "a".repeat(40) },
    plugins: { embedded: ["slack", "codex"], omitted: ["matrix"], omittedDirs: ["matrix"] },
    nativeModules: [],
    sqlite: { path: "lib/test-sqlite.dylib" },
    resourcePlan: {
      files: [
        { source: path.join(input.runtimeRoot, "asset.txt"), destination: "asset.txt" },
        {
          source: path.join(input.runtimeRoot, "lib/test-sqlite.dylib"),
          destination: "lib/test-sqlite.dylib",
        },
      ],
      directories: ["lib"],
    },
    ...overrides,
  };
}

async function compile(
  input: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof compileStandaloneArtifacts>[0]> = {},
) {
  const artifacts = await compileStandaloneArtifacts(compileOptions(input, overrides));
  const [standard, support] = artifacts;
  if (!standard || !support || artifacts.length !== 2) {
    throw new Error("Expected the standard and support fixture artifacts");
  }
  return [standard, support] satisfies [typeof standard, typeof support];
}

describe("matched standalone support artifacts", () => {
  it.skipIf(process.platform === "win32")(
    "retains requested AOT features and entrypoints without applying them to JIT support",
    async () => {
      const input = fixture();
      const second = path.join(input.compileRoot, "worker.js");
      fs.writeFileSync(second, "console.log('worker');");
      await compile(input, {
        compiledEntries: [input.mainEntry, second],
        compileEntries: new Set([input.mainEntry, second]),
        external: ["external-package"],
        compileFlags: ["--aot", "--trim-allow=run,jit", "--trim-locales=en"],
        aotCompileOptions: { trim: { allow: ["run", "jit"], locales: ["en"] } },
      });
      const options = JSON.parse(fs.readFileSync(input.compiler + ".options.json", "utf8"));
      expect(options).toEqual({
        entrypoints: ["main.js", "worker.js"],
        root: input.compileRoot,
        target: "bun",
        splitting: true,
        format: "esm",
        external: ["external-package"],
        compile: {
          outfile: path.join(input.outputRoot, "openclaw"),
          aot: true,
          trim: { allow: ["run", "jit"], locales: ["en"] },
          autoloadPackageJson: true,
          autoloadDotenv: false,
          autoloadBunfig: false,
        },
      });
      const support = JSON.parse(
        fs.readFileSync(path.join(input.outputRoot, "support-artifact/openclaw"), "utf8"),
      );
      expect(support.aot).toBe(false);
      expect(fs.existsSync(path.join(input.outputRoot, "compile-aot.mjs"))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "binds typed source and transforms to build identity while retaining relocation and support equality",
    async () => {
      const capture = async (annotation: string, transformedSuffix = "") => {
        const input = fixture();
        const sourceRoot = path.join(input.root, "source");
        fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, "package.json"), '{"type":"module"}\n');
        const source = `export function identity(value: ${annotation}): ${annotation} { return value; }\n`;
        fs.writeFileSync(path.join(sourceRoot, "src/index.ts"), source);
        fs.writeFileSync(path.join(sourceRoot, "src/helper.ts"), "export const helper = true;\n");
        fs.writeFileSync(path.join(sourceRoot, "tsconfig.json"), "{}\n");
        const sourceEntries = createStandaloneSourceEntries({
          sourceRoot,
          configs: [
            {
              entry: { entry: "src/index.ts" },
              alias: { "@fixture/helper": path.join(sourceRoot, "src/helper.ts") },
              cwd: sourceRoot,
              tsconfig: path.join(sourceRoot, "tsconfig.json"),
            },
          ],
        });
        const graph = createStandaloneSourceGraph({
          sourceRoot,
          outputRoot: input.outputRoot,
          runtimeRoot: input.runtimeRoot,
          sourceEntries,
          embeddedPaths: {},
        });
        const entry = graph.addEntry("dist/entry.mjs");
        if (!entry) {
          throw new Error("Missing typed source entry");
        }
        graph.recordLoaded(entry, source + transformedSuffix);
        const sourceGraphSha256 = standaloneSourceGraphSha256(sourceRoot, graph.manifest());
        const artifacts = await compile(input, { sourceGraphSha256 });
        return { sourceGraphSha256, artifacts };
      };
      const first = await capture("number");
      const relocated = await capture("number");
      const typeChanged = await capture("string");
      const transformChanged = await capture("number", "// changed compiler input\n");
      expect(relocated.artifacts[0].build).toEqual(first.artifacts[0].build);
      for (const changed of [typeChanged, transformChanged]) {
        expect(changed.sourceGraphSha256).not.toBe(first.sourceGraphSha256);
        expect(changed.artifacts[0].build.id).not.toBe(first.artifacts[0].build.id);
        expect(changed.artifacts[0].build.moduleGraphSha256).toBe(
          first.artifacts[0].build.moduleGraphSha256,
        );
      }
      for (const captured of [first, relocated, typeChanged, transformChanged]) {
        expect(captured.artifacts[1].build.id).toBe(captured.artifacts[0].build.id);
      }
    },
  );

  it("keeps bundled plugin fingerprints bound to the executing image's captured identity", () => {
    const runtimeRoot = tempDirs.make("standalone-fingerprint-");
    const entry = "dist/extensions/demo/state-operation-api.js";
    const entries = { [entry]: "/$bunfs/root/runtime/" + entry };
    const adapter = createStandaloneArtifactAdapter({ runtimeRoot, embeddedPaths: entries, parse });
    const record = {
      origin: "bundled",
      rootDir: path.join(runtimeRoot, "dist/extensions/demo"),
      source: "state-operation-api.js",
    };
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = ${JSON.stringify(runtimeRoot)};
const entries = ${JSON.stringify(entries)};
globalThis.__openclawStandaloneBuildInfo = { build: { id: "image-a" } };
${adapter.bootstrap}
globalThis.__openclawStandaloneBuildInfo = { build: { id: "image-b" } };
const record = ${JSON.stringify(record)};
const fingerprint = globalThis.__openclawStandaloneFingerprintArtifact;
console.log(JSON.stringify([fingerprint(record), fingerprint({ ...record, sourcePreferred: true })]));
`,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      'image-a:["dist/extensions/demo","dist/extensions/demo/state-operation-api.js"]',
      null,
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "runs original-source AOT through the shared build owner",
    async () => {
      const input = fixture();
      const seen: object[] = [];
      const artifacts = await compileStandaloneArtifacts(
        compileOptions(input, {
          supportDestination: undefined,
          async compileAot({ outfile, buildInfo }) {
            seen.push(buildInfo);
            fs.writeFileSync(outfile, JSON.stringify(buildInfo));
          },
        }),
      );
      expect(seen).toHaveLength(1);
      expect(artifacts.map(({ mode }) => mode)).toEqual(["aot"]);
      const aot = JSON.parse(fs.readFileSync(path.join(input.outputRoot, "openclaw"), "utf8"));
      expect(aot.mode).toBe("aot");
      expect(aot.build.id).toMatch(/^[0-9a-f]{64}$/);
      expect(aot.build.moduleGraphSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.readFileSync(input.mainEntry, "utf8")).toBe(input.source);
    },
  );
  it.skipIf(process.platform === "win32")(
    "publishes matching provenance, resources and debugger sources with distinct compilation modes",
    async () => {
      const input = fixture();
      const artifacts = await compile(input);
      expect(fs.existsSync(path.join(input.root, "aot"))).toBe(false);
      expect(fs.readFileSync(input.mainEntry, "utf8")).toBe(input.source);
      for (const name of [
        "openclaw.mjs",
        "leaf.mjs",
        "leaf.mjs.map",
        "cli-invocation.mjs",
        "cli-parent-lifetime.mjs",
        "gateway-shutdown-budget.mjs",
        "node-runtime-env.mjs",
      ]) {
        fs.unlinkSync(path.join(input.runtimeRoot, name));
      }
      fs.rmSync(path.join(input.runtimeRoot, "node_modules"), { recursive: true });
      await publishStandaloneArtifacts({
        artifacts,
        runtimeRoot: input.runtimeRoot,
        manifestInputs: {
          bun: { version: "1.4.4" },
          openclaw: { version: "2026.10.3", commit: "a".repeat(40) },
          plugins: { embedded: ["slack", "codex"], omitted: ["matrix"] },
          pluginContract: {
            schemaVersion: 1,
            sdk: {
              "openclaw/plugin-sdk/core": {
                source: "dist/plugin-sdk/core.js",
                entry: "/$bunfs/root/core.js",
              },
            },
            plugins: {},
          },
          nativeModules: [],
          embedded: { modules: 1, plugins: 2, workers: 0, inlineWorkers: 0 },
          pruning: {
            categories: {
              dependencyAssets: { files: 1, bytes: 14 },
              nativeLibraries: { files: 1, bytes: Buffer.byteLength("synthetic SQLite library") },
            },
            sidecarPlugins: [],
          },
          sqlite: { version: "3.53.4" },
          packageManager: undefined,
        },
      });
      const aot = JSON.parse(fs.readFileSync(path.join(input.root, "aot/manifest.json"), "utf8"));
      const support = JSON.parse(
        fs.readFileSync(path.join(input.root, "support/manifest.json"), "utf8"),
      );
      expect(aot).toMatchObject({
        mode: "aot",
        build: { id: expect.stringMatching(/^[a-f0-9]{64}$/), flavor: "standard" },
        plugins: {
          embedded: ["codex", "slack"],
          contract: {
            schemaVersion: 1,
            sdk: {
              "openclaw/plugin-sdk/core": {
                source: "dist/plugin-sdk/core.js",
                entry: "/$bunfs/root/core.js",
              },
            },
            plugins: {},
          },
        },
      });
      expect(support).toMatchObject({
        mode: "jit",
        build: { id: aot.build.id, flavor: "support", debugEntry: "debug/entry.mjs" },
        openclaw: aot.openclaw,
        plugins: aot.plugins,
        debug: {
          entry: { path: "debug/entry.mjs" },
          executable: { path: "debug/bin/bun" },
          runtime: { path: "debug/runtime" },
        },
      });
      expect(support.build.moduleGraphSha256).toBe(aot.build.moduleGraphSha256);
      expect(support.build.pluginSetSha256).toBe(aot.build.pluginSetSha256);
      expect(support.runtime.sha256).toBe(aot.runtime.sha256);
      expect(JSON.parse(fs.readFileSync(path.join(input.root, "aot/openclaw"), "utf8")).aot).toBe(
        true,
      );
      const supportOutput = JSON.parse(
        fs.readFileSync(path.join(input.root, "support/openclaw"), "utf8"),
      );
      expect(supportOutput.aot).toBe(false);
      expect(supportOutput.source).toContain('"flavor":"support"');
      expect(fs.readlinkSync(path.join(input.root, "support/runtime/asset-link"))).toBe(
        "asset.txt",
      );
      expect(fs.readFileSync(path.join(input.root, "support/runtime/asset-link"), "utf8")).toBe(
        "same resource\n",
      );
      expect(fs.existsSync(path.join(input.root, "support/debug/runtime/leaf.mjs.map"))).toBe(true);
      expect(
        fs.existsSync(path.join(input.root, "support/debug/runtime/node_modules/matrix")),
      ).toBe(false);
      const debug = spawnSync(
        path.join(input.root, "support/debug/bin/bun"),
        [path.join(input.root, "support/debug/entry.mjs"), "--debug-child"],
        { encoding: "utf8", env: { ...process.env, OPENCLAW_SQLITE_LIBRARY: "" } },
      );
      expect(debug.status, debug.stderr).toBe(0);
      const bundledSqlite = path.join(input.root, "support/debug/runtime/lib/test-sqlite.dylib");
      expect
        .soft(JSON.parse(debug.stdout))
        .toEqual({ answer: 42, mode: "jit", sqliteLibrary: bundledSqlite });
      const respawned = spawnSync(
        path.join(input.root, "support/debug/bin/bun"),
        [path.join(input.root, "support/debug/entry.mjs")],
        { encoding: "utf8", env: { ...process.env, OPENCLAW_SQLITE_LIBRARY: "" } },
      );
      expect(respawned.status, respawned.stderr).toBe(0);
      expect
        .soft(JSON.parse(respawned.stdout))
        .toEqual({ answer: 42, mode: "jit", sqliteLibrary: bundledSqlite });
      const overridden = spawnSync(
        path.join(input.root, "support/debug/bin/bun"),
        [path.join(input.root, "support/debug/entry.mjs")],
        {
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_SQLITE_LIBRARY: "synthetic-override" },
        },
      );
      expect(overridden.status, overridden.stderr).toBe(0);
      expect(JSON.parse(overridden.stdout)).toEqual({
        answer: 42,
        mode: "jit",
        sqliteLibrary: "synthetic-override",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not publish either destination when companion compilation fails",
    async () => {
      const input = fixture(true);
      await expect(compile(input)).rejects.toThrow("support compilation failed (42)");
      expect(fs.existsSync(path.join(input.root, "aot"))).toBe(false);
      expect(fs.existsSync(path.join(input.root, "support"))).toBe(false);
      expect(fs.readFileSync(input.mainEntry, "utf8")).toBe(input.source);
    },
  );

  it.skipIf(process.platform === "win32")(
    "ignores local freshness stamps when building independent copies of the same inputs",
    async () => {
      const first = fixture();
      const second = fixture();
      const plans = [first, second].map((input, index) => {
        fs.mkdirSync(path.join(input.runtimeRoot, "dist"));
        fs.writeFileSync(
          path.join(input.runtimeRoot, "dist/build-info.json"),
          JSON.stringify({ commit: "a".repeat(40), builtAt: "2026-10-24T00:00:00.000Z" }),
        );
        fs.writeFileSync(
          path.join(input.runtimeRoot, "dist/.buildstamp"),
          JSON.stringify({ head: "a".repeat(40), builtAt: 1000 + index }),
        );
        fs.writeFileSync(
          path.join(input.runtimeRoot, "dist/.runtime-postbuildstamp"),
          JSON.stringify({ head: "a".repeat(40), syncedAt: 2000 + index }),
        );
        return planStandaloneRuntime(input.runtimeRoot, [
          { source: "asset.txt", destination: "asset.txt", category: "dependencyAssets" },
          {
            source: "lib/test-sqlite.dylib",
            destination: "lib/test-sqlite.dylib",
            category: "nativeLibraries",
          },
        ]);
      });
      const [a, b] = await Promise.all([
        compile(first, { resourcePlan: plans[0] }),
        compile(second, { resourcePlan: plans[1] }),
      ]);
      expect(a[0].build.id).toMatch(/^[a-f0-9]{64}$/);
      expect(b[0].build).toEqual(a[0].build);
      expect(fs.readFileSync(path.join(second.outputRoot, "openclaw"))).toEqual(
        fs.readFileSync(path.join(first.outputRoot, "openclaw")),
      );
      for (const plan of plans) {
        pruneStandaloneRuntime(plan);
        expect(fs.existsSync(path.join(plan.root, "dist/build-info.json"))).toBe(true);
        expect(fs.existsSync(path.join(plan.root, "dist/.buildstamp"))).toBe(false);
        expect(fs.existsSync(path.join(plan.root, "dist/.runtime-postbuildstamp"))).toBe(false);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "changes build identity when compiled code, native resources, compiler, or policy changes",
    async () => {
      const input = fixture();
      const [original] = await compile(input);
      fs.appendFileSync(input.mainEntry, "\nconsole.log('changed');\n");
      const [codeChanged] = await compile(input);
      expect(codeChanged.build.id).not.toBe(original.build.id);
      fs.writeFileSync(input.mainEntry, input.source);
      fs.writeFileSync(
        path.join(input.runtimeRoot, "lib/test-sqlite.dylib"),
        "changed native library",
      );
      const [nativeChanged] = await compile(input);
      expect(nativeChanged.build.id).not.toBe(original.build.id);
      fs.writeFileSync(
        path.join(input.runtimeRoot, "lib/test-sqlite.dylib"),
        "synthetic SQLite library",
      );
      const [compilerChanged] = await compile(input, {
        bun: { version: "1.4.4", revision: "another-compiler" },
      });
      expect(compilerChanged.build.id).not.toBe(original.build.id);
      const [policyChanged] = await compile(input, { compileFlags: ["--aot", "--trim"] });
      expect(policyChanged.build.id).not.toBe(original.build.id);
    },
  );

  it("rejects output collisions before staging artifacts", () => {
    const root = tempDirs.make("standalone-destinations-");
    expect(() => assertStandaloneDestinations([root])).toThrow("already exists");
    for (const paths of [
      ["out", "out"],
      ["out", "out/support"],
      ["out/support", "out"],
    ]) {
      expect(() => assertStandaloneDestinations(paths.map((p) => path.join(root, p)))).toThrow(
        "non-nested",
      );
    }
  });

  it("records native package versions without loading or certifying their binaries", () => {
    const root = tempDirs.make("standalone-native-inventory-");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "onnxruntime-node", version: "1.30.0" }),
    );
    expect(
      describeStandaloneNativeModules({
        runtimeRoot: root,
        sqlite: { version: "3.53.4" },
        resources: [
          {
            source: "package.json",
            destination: "native/onnx/package.json",
            category: "dependencyMetadata",
          },
          {
            source: "missing.node",
            destination: "native/onnx/binding.node",
            category: "nativeAddons",
          },
        ],
      }),
    ).toEqual([
      {
        name: "onnxruntime-node",
        version: "1.30.0",
        artifacts: ["native/onnx/binding.node"],
        qualification: "unverified",
        backend: "runtime-selected",
      },
      {
        name: "sqlite",
        version: "3.53.4",
        artifacts: [],
        qualification: "unverified",
        backend: "sqlite",
      },
    ]);
  });
});
