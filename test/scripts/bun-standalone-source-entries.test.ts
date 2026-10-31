import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { UserConfig } from "tsdown";
import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneSourceEntries } from "../../scripts/lib/bun-standalone-source-entries.mjs";
import {
  createPluginNpmRuntimeBuildOptions,
  resolvePluginNpmRuntimeBuildPlan,
} from "../../scripts/lib/plugin-npm-runtime-build.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const root = tempDirs.make("openclaw-source-entries-");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  const contents = "export const value: number = 42;\n";
  fs.writeFileSync(path.join(root, "src/owner.ts"), contents);
  return { root, contents };
}

describe("standalone original-source entries", () => {
  it("assigns package-owned worker wrappers to their isolated plugin build", () => {
    const loader = pathToFileURL(path.resolve("scripts/lib/bun-standalone-source-entries.mjs"));
    const env = { ...process.env };
    delete env.OPENCLAW_TSDOWN_CACHE_PENDING;
    delete env.OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS;
    delete env.OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS;
    const result = execFileSync(
      "node",
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        "--input-type=module",
        "--eval",
        `const { loadStandaloneSourceEntries } = await import(${JSON.stringify(loader.href)});
const entries = await loadStandaloneSourceEntries({ sourceRoot: process.cwd() });
console.log(JSON.stringify(["catalog-page", "session-history"].map((name) => {
  const entry = entries.resolve("dist/extensions/codex/" + name + "-worker-entrypoint.js");
  return { source: entry?.relativeSource, plugin: entry?.pluginEntry?.id };
})));`,
      ],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 },
    );
    expect(JSON.parse(result)).toEqual([
      { source: "extensions/codex/catalog-page-worker-entrypoint.ts", plugin: "codex" },
      { source: "extensions/codex/session-history-worker-entrypoint.ts", plugin: "codex" },
    ]);
  });

  it("loads original JavaScript workers through the public manifest projection", () => {
    const { root } = fixture();
    const write = (name: string, contents: string) => {
      const filename = path.join(root, name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, contents);
    };
    write("tsdown.config.ts", "export default [];\n");
    write("tsdown.ai.config.ts", "export default { entry: {} };\n");
    write(
      "scripts/lib/bundled-plugin-build-entries.mjs",
      "export const collectSourceCheckoutPluginBuildEntries = () => [];\n",
    );
    write("scripts/lib/plugin-npm-runtime-build.mts", "export {};\n");
    write(
      "scripts/lib/static-extension-assets.mts",
      "export const discoverStaticExtensionAssets = () => [];\n",
    );
    const manifest = pathToFileURL(path.resolve("src/infra/runtime-process-manifest.ts"));
    write(
      "src/infra/runtime-process-manifest.ts",
      `export { createStandaloneRuntimeProcessEntrypoints } from ${JSON.stringify(manifest.href)};\n`,
    );
    const loader = pathToFileURL(path.resolve("scripts/lib/bun-standalone-source-entries.mjs"));
    const result = execFileSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `const { loadStandaloneSourceEntries } = await import(${JSON.stringify(loader.href)});
const entries = await loadStandaloneSourceEntries({ sourceRoot: process.cwd() });
console.log(JSON.stringify(entries.unmappedWorkers(["openclaw.mjs", "node-compile-cache.mjs"])));`,
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    expect(JSON.parse(result)).toEqual([]);
  });

  it("selects named runtime roots while retaining discovered workers and auxiliary programs", () => {
    const { root } = fixture();
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist/discovered-worker.mjs"), "export const worker = 1;\n");
    const index = createStandaloneSourceEntries({
      sourceRoot: root,
      configs: [
        {
          entry: {
            entry: "src/owner.ts",
            "plugin-sdk/public": "src/owner.ts",
            "extensions/example/index": "src/owner.ts",
          },
          fixedExtension: false,
        },
      ],
      workerEntries: ["dist/discovered-worker.mjs"],
    });
    const entries = [
      "dist/entry.js",
      "dist/private-hash.mjs",
      "dist/plugin-sdk/public.js",
      "dist/extensions/example/index.js",
      "dist/extensions/example/private-hash.mjs",
      "dist/discovered-worker.mjs",
      "openclaw.mjs",
      "packages/runtime/dist/index.mjs",
      "node_modules/dependency/index.js",
      "../standalone-worker-threads.cjs",
    ];
    expect(index.selectRuntimeEntries(entries)).toEqual([
      "dist/entry.js",
      "dist/plugin-sdk/public.js",
      "dist/extensions/example/index.js",
      "dist/discovered-worker.mjs",
      "openclaw.mjs",
      "packages/runtime/dist/index.mjs",
      "node_modules/dependency/index.js",
      "../standalone-worker-threads.cjs",
    ]);
  });

  it("uses the named build contract and retains its types and configuration", () => {
    const { root, contents } = fixture();
    const config = {
      entry: { "public/launch": "src/owner.ts" },
      outDir: "dist",
      platform: "node",
      fixedExtension: false,
      define: { SEALED_RUNTIME_BUILD: "false" },
      env: { NODE_ENV: "production" },
    } satisfies UserConfig;
    const index = createStandaloneSourceEntries({ sourceRoot: root, configs: [config] });
    expect(index.resolve("dist/public/launch.js")).toMatchObject({
      output: "dist/public/launch.js",
      source: path.join(root, "src/owner.ts"),
      relativeSource: "src/owner.ts",
      sourceSha256: createHash("sha256").update(contents).digest("hex"),
      loader: "ts",
      format: "esm",
      config,
      configIndex: 0,
    });
    expect(index.resolve("dist/public/launch.js")?.config).toBe(config);
    expect(index.resolve("dist/owner.js")).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "src/owner.ts"), "utf8")).toBe(contents);
  });

  it("keeps distinct runtime modes for the same original source", () => {
    const { root } = fixture();
    const ordinary = {
      entry: { "normal/worker": "src/owner.ts" },
      define: { WORKER_DEPLOY_BUILD: "false" },
    };
    const sealed = {
      entry: { "worker/sealed": "src/owner.ts" },
      define: { WORKER_DEPLOY_BUILD: "true", SEALED_RUNTIME_BUILD: "true" },
      outExtensions: () => ({ js: ".mjs" }),
      outputOptions: { entryFileNames: ({ name }: { name: string }) => `${name}.mjs` },
    };
    const index = createStandaloneSourceEntries({
      sourceRoot: root,
      configs: [
        ordinary,
        sealed,
        { ...ordinary, entry: { "normal/other": "src/owner.ts" } },
        { entry: ordinary.entry, dts: { emitDtsOnly: true } },
      ],
    });
    expect(index.resolve("dist/normal/worker.mjs")?.config).toBe(ordinary);
    expect(index.resolve("dist/worker/sealed.mjs")?.config).toBe(sealed);
    expect(index.resolve("dist/normal/worker.mjs")?.contextId).toBe(
      index.resolve("dist/normal/other.mjs")?.contextId,
    );
    expect(index.resolve("dist/normal/worker.mjs")?.contextId).not.toBe(
      index.resolve("dist/worker/sealed.mjs")?.contextId,
    );
    expect(index.unmappedWorkers(["dist/worker/sealed.mjs", "dist/private-hash.mjs"])).toEqual([
      "dist/private-hash.mjs",
    ]);
    expect(() =>
      createStandaloneSourceEntries({ sourceRoot: root, configs: [ordinary, ordinary] }),
    ).toThrow("Multiple build owners");
  });

  it("uses isolated plugin plan outputs without imposing a root-bundle format", () => {
    const { root } = fixture();
    const packageDir = path.join(root, "extensions/plugin");
    writeJsonFile(path.join(packageDir, "package.json"), {
      name: "@openclaw/plugin",
      version: "1.0.0",
      type: "module",
      dependencies: { dependency: "1.0.0" },
      openclaw: { extensions: ["./index.ts"], build: { runtimeFormat: "cjs" } },
    });
    fs.writeFileSync(path.join(packageDir, "index.ts"), "export const value: number = 42;\n");
    const plan = resolvePluginNpmRuntimeBuildPlan({ repoRoot: root, packageDir });
    assert(plan, "Missing fixture runtime plan");
    const [config] = createPluginNpmRuntimeBuildOptions(plan);
    assert(config, "Missing fixture runtime build");
    const index = createStandaloneSourceEntries({
      sourceRoot: root,
      configs: [],
      pluginEntries: [
        {
          id: "plugin",
          isolated: true,
          sourceEntries: plan.sourceEntries,
          runtimeExtension: ".cjs",
          runtimeBuildPlan: plan,
          runtimeBuildConfigs: [config],
        },
      ],
    });
    const entry = index.resolve("dist/extensions/plugin/index.cjs");
    expect(entry?.loader).toBe("ts");
    expect(entry?.format).toBe("cjs");
    expect(entry?.pluginPlan).toBe(plan);
    expect(entry?.config).toBe(config);
    expect(entry?.configIndex).toBeUndefined();
    expect(entry?.semanticInputsKnown).toBe(true);
    expect(config.deps.alwaysBundle("openclaw/plugin-sdk/text-grapheme")).toBe(true);
    expect(config.deps.neverBundle("openclaw/plugin-sdk/text-grapheme")).toBe(false);
    expect(config.deps.neverBundle("dependency/subpath")).toBe(true);
    expect(config.deps.neverBundle("openclaw/plugin-sdk/host-owned")).toBe(true);
  });

  it("refuses a hashed entry contract that needs the emitting compiler's metadata", () => {
    const { root } = fixture();
    expect(() =>
      createStandaloneSourceEntries({
        sourceRoot: root,
        configs: [
          {
            entry: { runtime: "src/owner.ts" },
            outputOptions: { entryFileNames: "[name]-[hash].mjs" },
          },
        ],
      }),
    ).toThrow("non-stable output name");
  });

  it("maps only declared build entries and explicitly owned original JavaScript programs", () => {
    const { root } = fixture();
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(
      path.join(root, "dist/self-hash.mjs"),
      "//#region src/owner.ts\nconst workerUrl = new URL(import.meta.url);\n//#endregion\n",
    );
    const config = { entry: { worker: "src/owner.ts" }, define: { WORKER_DEPLOY_BUILD: "false" } };
    const workers = [
      "dist/worker.mjs",
      "dist/self-hash.mjs",
      "openclaw.mjs",
      "dist/extensions/example/launcher.mjs",
    ];
    const index = createStandaloneSourceEntries({
      sourceRoot: root,
      configs: [config],
      workerEntries: workers,
      originalJavaScriptEntries: ["openclaw.mjs", "dist/extensions/example/launcher.mjs"],
    });
    expect(index.unmappedWorkers(workers)).toEqual(["dist/self-hash.mjs"]);
    expect(index.resolve("dist/worker.mjs")?.relativeSource).toBe("src/owner.ts");
    expect(index.resolve("dist/self-hash.mjs")).toBeUndefined();
  });
});
