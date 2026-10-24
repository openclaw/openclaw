import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function compile(input: ReturnType<typeof fixture>) {
  return compileStandaloneArtifacts({
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
    buildId: "matched-build",
  });
}

describe("matched standalone support artifacts", () => {
  it.skipIf(process.platform === "win32")(
    "publishes matching provenance, resources and debugger sources with distinct compilation modes",
    async () => {
      const input = fixture();
      const artifacts = compile(input);
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
        build: { id: "matched-build", flavor: "standard" },
        plugins: { embedded: ["codex", "slack"] },
      });
      expect(support).toMatchObject({
        mode: "jit",
        build: { id: "matched-build", flavor: "support", debugEntry: "debug/entry.mjs" },
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
    () => {
      const input = fixture(true);
      expect(() => compile(input)).toThrow("support compilation failed (42)");
      expect(fs.existsSync(path.join(input.root, "aot"))).toBe(false);
      expect(fs.existsSync(path.join(input.root, "support"))).toBe(false);
      expect(fs.readFileSync(input.mainEntry, "utf8")).toBe(input.source);
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
