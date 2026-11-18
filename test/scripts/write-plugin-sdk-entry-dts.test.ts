import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect } from "vitest";
import {
  pluginSdkEntrypoints,
  publicPluginSdkEntrypoints,
} from "../../scripts/lib/plugin-sdk-entries.mts";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import {
  createDeclarationFixture as createFixture,
  createDeclarationFixtureWriter,
  createDeclarationTest,
  declarationCacheRecords,
  declarationInputs,
  expectOutputs,
  expectStagingClean,
  loader,
  runFixture,
  runWriter,
  treeHashes,
} from "./tsdown-declaration-fixture.js";

const compiler = path.resolve("scripts/run-tsgo.mjs");
// Repeated end-to-end writer runs exceed the default timeout on Windows.
const WRITER_TEST_TIMEOUT_MS = process.platform === "win32" ? 360_000 : 120_000;

const it = createDeclarationTest();

function expectCompiled(result: { status: number | null; stdout: string; stderr: string }) {
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(
    (result.stdout + result.stderr).match(/\[tsdown-build\] invocation \d\/1 finished/gu),
  ).toHaveLength(1);
}

describe("write-plugin-sdk-entry-dts", { timeout: WRITER_TEST_TIMEOUT_MS }, () => {
  it("refuses fixture writes through borrowed dependencies before changing their files", ({
    command,
  }) => {
    const root = fs.realpathSync(command.createTempDir("declaration-fixture-writer-"));
    const borrowed = fs.realpathSync(command.createTempDir("declaration-borrowed-dependency-"));
    fs.writeFileSync(path.join(borrowed, "worker.js"), "export const untouched = true;\n");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(borrowed, path.join(root, "node_modules/borrowed"), "junction");
    const write = createDeclarationFixtureWriter(root);
    for (const file of ["worker.js", "new/directory/worker.js"]) {
      expect(() => write(`node_modules/borrowed/${file}`, "export {};\n")).toThrow(
        "Declaration input escapes checkout",
      );
    }
    expect(fs.readFileSync(path.join(borrowed, "worker.js"), "utf8")).toBe(
      "export const untouched = true;\n",
    );
    expect(fs.readdirSync(borrowed)).toEqual(["worker.js"]);
    write("node_modules/synthetic/worker.js", "export const owned = true;\n");
    expect(fs.readFileSync(path.join(root, "node_modules/synthetic/worker.js"), "utf8")).toBe(
      "export const owned = true;\n",
    );
  });

  // POSIX uses the nested-writer retention case in dist-artifact-ownership.test.ts.
  it.skipIf(process.platform !== "win32").concurrent(
    "retains private stages and both compiler errors when a child is unjoined",
    ({ command }) =>
      command.lifetime.run(async () => {
        const { root, write } = createFixture(command);
        write("dist/plugin-sdk/core.d.ts", "previous generation");
        const before = treeHashes(path.join(root, "dist"));
        // Inject the executor's terminal error contract, without leaving a real process behind.
        write(
          "scripts/lib/declaration-stage.mts",
          `export async function publishStagedDeclarations() {
        throw new AggregateError([
          new Error("first compiler failed"),
          Object.assign(new Error("second compiler unjoined"), { processTreeState: "live" }),
        ], "compiler batch failed");
      }`,
        );
        const result = await runWriter(command, root, true);
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain("first compiler failed");
        expect(result.stdout + result.stderr).toContain("second compiler unjoined");
        expect(treeHashes(path.join(root, "dist"))).toEqual(before);
        expect(
          fs
            .readdirSync(path.join(root, ".artifacts"))
            .filter((name) => name.startsWith("plugin-sdk-staging-")),
        ).toHaveLength(2);
        expect(fs.existsSync(path.join(root, ".artifacts/dist-artifacts.lock/unjoined"))).toBe(
          true,
        );
      }),
  );

  it.concurrent("preserves repository input metadata during direct declaration builds", ({
    command,
  }) =>
    command.lifetime.run(async () => {
      const watchWorker = path.resolve("node_modules/@openclaw/fs-safe/dist/watch-io-worker.js");
      const dependencyBefore = fs.readFileSync(watchWorker);
      const { root, write, declarations, production } = createFixture(command);
      for (const [name, roots] of Object.entries(declarations)) {
        write(
          `compiler-inputs/${name}.json`,
          JSON.stringify({ roots, sentinel: "repository input" }),
        );
      }
      const before = treeHashes(path.join(root, "compiler-inputs"));
      const direct = await runFixture(command, root, [
        "--import",
        loader,
        path.resolve("scripts/tsdown-build.mts"),
        "--config",
        "tsdown.config.ts",
        ...Object.keys(declarations).flatMap((name) => ["--filter", name]),
      ]);
      expectCompiled(direct);
      expect(treeHashes(path.join(root, "compiler-inputs"))).toEqual(before);
      expectOutputs(root, production, Object.keys(treeHashes(path.join(root, "dist"))));
      expectStagingClean(root);
      expect(fs.readFileSync(watchWorker)).toEqual(dependencyBefore);
    }));

  it.concurrent.for<[string, string, NodeJS.ProcessEnv, NodeJS.ProcessEnv]>([
    ["bounded plugins", "broken", { OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "plain" }, {}],
    ["optional plugins", "acpx", { OPENCLAW_INCLUDE_OPTIONAL_BUNDLED: "0" }, {}],
    ["Docker plugins", "external", {}, { OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: "external" }],
  ])(
    "rejects newly selected %s instead of restoring their previous SDK cache",
    ([_name, badPlugin, before, after], { command }) =>
      command.lifetime.run(async () => {
        const { root, write } = createFixture(command);
        for (const id of ["plain", badPlugin]) {
          write(`extensions/${id}/openclaw.plugin.json`, JSON.stringify({ id }));
          write(
            `extensions/${id}/package.json`,
            JSON.stringify({
              name: `@openclaw/${id}`,
              openclaw: { build: { bundledDist: id !== "external" } },
            }),
          );
          if (id !== badPlugin) {
            write(`extensions/${id}/index.ts`, "export {};\n");
          }
        }
        const initial = await runWriter(command, root, false, before);
        expect(initial.status, initial.stdout + initial.stderr).toBe(0);
        const published = treeHashes(path.join(root, "dist"));
        const selected = await runWriter(command, root, false, after);
        expect(selected.status, selected.stdout + selected.stderr).toBeGreaterThan(0);
        expect(selected.stdout + selected.stderr).toContain(`extensions/${badPlugin}/index.ts`);
        expect(treeHashes(path.join(root, "dist"))).toEqual(published);
        expectStagingClean(root);
      }),
  );

  it.concurrent("publishes the canonical SDK graph with stable bytes and public nominal identity", ({
    command,
  }) =>
    command.lifetime.run(async () => {
      const { root, write, writeDeclarations, production, qa } = createFixture(command);
      const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
      const build = async (privateQa = false) => {
        expectCompiled(await runWriter(command, root, privateQa));
        const output = treeHashes(path.join(root, "dist"));
        expectOutputs(root, privateQa ? qa : production, Object.keys(output));
        expectStagingClean(root);
        return output;
      };
      expect(production.toSorted()).toEqual(
        publicPluginSdkEntrypoints.map((entry) => `plugin-sdk/${entry}`).toSorted(),
      );
      expect(qa).toEqual(
        expect.arrayContaining(pluginSdkEntrypoints.map((entry) => `plugin-sdk/${entry}`)),
      );
      const preserved = [
        "dist/plugin-sdk/core.js",
        "dist/plugin-sdk/.tsbuildinfo",
        "dist/plugin-sdk/src/retained.d.ts",
        "dist/unrelated.d.ts",
        "packages/plugin-sdk/dist/src/plugin-sdk/core.d.ts",
        "packages/plugin-sdk/dist/.tsbuildinfo",
        ".artifacts/extension-package-boundary/plugins/qa-channel/api.d.ts",
      ];
      for (const relative of preserved) {
        write(relative, relative);
      }

      const before = await build();
      const records = declarationCacheRecords(root);
      expect(records).toHaveLength(1);
      const inputs = records.flatMap((record) => record.inputs ?? []);
      expect(inputs).toEqual(
        expect.arrayContaining([
          ...declarationInputs.map(({ file }) => file),
          "src/shared.ts",
          "src/schema.d.ts",
          "contracts/before.ts",
        ]),
      );
      expect(inputs.some((file) => file.endsWith("/lib.es2023.d.ts"))).toBe(true);
      expect(inputs).not.toContain("test/unrelated.test.ts");
      expect(inputs).not.toContain("ui/unrelated.ts");
      for (const entry of qa.filter((candidate) => !production.includes(candidate))) {
        expect(fs.existsSync(path.join(root, `dist/${entry}.d.ts`)), entry).toBe(false);
      }

      // Identical sources with a different QA selection must emit the extra canonical entries.
      const priorOutputs = await build(true);

      writeDeclarations("after");
      fs.rmSync(path.join(root, "contracts/before.ts"));
      write("dist/plugin-sdk/obsolete.d.ts", "obsolete flat declaration");
      const first = await build(true);
      const cachedDistFiles = new Set(
        declarationCacheRecords(root).flatMap((record) =>
          Object.keys(record.outputs)
            .filter((file) => file.startsWith("dist/"))
            .map((file) => file.slice("dist/".length)),
        ),
      );
      expect(first).not.toEqual(before);
      expect(fs.existsSync(path.join(root, "dist/plugin-sdk/obsolete.d.ts"))).toBe(false);
      for (const relative of preserved) {
        expect(read(relative)).toBe(relative);
      }
      expect(read("src/schema.sql")).toBe("CREATE TABLE fixture (value TEXT NOT NULL);");

      // One restore proves portable, byte-stable reuse despite unrelated edits.
      // Copy only the cache: copying Windows junctions can change the source topology.
      const {
        root: relocated,
        write: writeRelocated,
        writeDeclarations: writeRelocatedDeclarations,
      } = createFixture(command);
      writeRelocatedDeclarations("after");
      fs.rmSync(path.join(relocated, "contracts/before.ts"));
      writeRelocated("test/unrelated.test.ts", "export const test = 2;\n");
      writeRelocated("ui/unrelated.ts", "export const view = 2;\n");
      writeRelocated(".github/workflows/unrelated.yml", "name: unrelated after\n");
      for (const relative of preserved) {
        writeRelocated(relative, relative);
      }
      // The QA build can add shared chunks after the production snapshot. Seed
      // only unowned history; current cache outputs must come from the restore.
      for (const file of Object.keys(priorOutputs).filter(
        (entry) => !entry.startsWith("plugin-sdk/") && !cachedDistFiles.has(entry),
      )) {
        expect(first[file]).toBe(priorOutputs[file]);
        writeRelocated(`dist/${file}`, read(`dist/${file}`));
      }
      writeRelocated("dist/plugin-sdk/obsolete.d.ts", "obsolete restored declaration");
      fs.cpSync(
        path.join(root, ".artifacts/build-all-cache"),
        path.join(relocated, ".artifacts/build-all-cache"),
        { recursive: true },
      );
      const restored = await runWriter(command, relocated, true);
      expect(restored.status, restored.stdout + restored.stderr).toBe(0);
      expect(restored.stdout + restored.stderr).not.toContain("[tsdown-build] invocation");
      const restoredFiles = treeHashes(path.join(relocated, "dist"));
      // Include shared root chunks, not just flat SDK entries, in filename/byte determinism.
      expect(restoredFiles).toEqual(first);
      expectOutputs(relocated, qa, Object.keys(restoredFiles));
      expectStagingClean(relocated);
      for (const relative of preserved) {
        expect(fs.readFileSync(path.join(relocated, relative), "utf8")).toBe(relative);
      }

      write(
        "consumer.ts",
        [
          'import type { Shared } from "./dist/plugin-sdk/core.js";',
          'import type { Shared as ChannelShared } from "./dist/plugin-sdk/channel-core.js";',
          `import type { TransitiveAlias, ${declarationInputs.map(({ name }) => name).join(", ")} } from "./dist/plugin-sdk/test-fixtures.js";`,
          "declare const shared: Shared; const canonical: ChannelShared = shared;",
          "declare const channelShared: ChannelShared; const publicShared: Shared = channelShared;",
          "// @ts-expect-error An empty object cannot satisfy the nominal SDK class.",
          "const impostor: Shared = {}; void impostor;",
          "// @ts-expect-error The second public subpath must retain the nominal class too.",
          "const channelImpostor: ChannelShared = {}; void channelImpostor;",
          ...["TransitiveAlias", ...declarationInputs.map(({ name }) => name)].map(
            (name) => `const current${name}: ${name} = { value: "after" }; void current${name};`,
          ),
          "void canonical; void publicShared;",
        ].join("\n"),
      );
      write(
        "consumer.json",
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            types: [],
          },
          files: ["consumer.ts"],
        }),
      );
      const consumer = spawnSync(
        requireNodeTool("node"),
        [compiler, "-p", path.join(root, "consumer.json"), "--noEmit"],
        { cwd: root, encoding: "utf8" },
      );
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(0);
    }));

  it.concurrent.for([
    {
      source: "source declaration export",
      diagnostics: ["TS1110", "src/contract.d.ts", "Type expected"],
    },
    {
      source: "transitive declaration export",
      diagnostics: ["TS1109", "contracts/before.ts", "Expression expected"],
    },
    { source: "missing entry", diagnostics: ["core.ts"] },
    { source: "invalid config", diagnostics: ["missing-config.json"] },
    { source: "missing declaration", diagnostics: ["contract"] },
  ])(
    "rejects $source before replacing published or local declarations",
    ({ source, diagnostics }, { command }) =>
      command.lifetime.run(async () => {
        const { root, write } = createFixture(command);
        write("dist/plugin-sdk/core.d.ts", "previous declaration");
        write("dist/shared.d.ts", "previous shared declaration");
        write("packages/plugin-sdk/dist/src/plugin-sdk/core.d.ts", "previous local declaration");
        const published = treeHashes(path.join(root, "dist"));
        const local = treeHashes(path.join(root, "packages/plugin-sdk/dist"));
        if (source === "source declaration export") {
          write("src/contract.d.ts", "export type SourceOnly = ;");
        } else if (source === "transitive declaration export") {
          write("contracts/before.ts", "export const broken = ;");
        } else if (source === "missing entry") {
          fs.rmSync(path.join(root, "src/plugin-sdk/core.ts"));
        } else if (source === "invalid config") {
          write("tsconfig.json", '{"extends":"./missing-config.json"}');
        } else if (source === "missing declaration") {
          fs.rmSync(path.join(root, "src/contract.d.ts"));
        }
        const failed = await runWriter(command, root, true);
        expect(failed.error).toBeUndefined();
        expect(failed.signal).toBeNull();
        expect(failed.status, failed.stdout + failed.stderr).toBeGreaterThan(0);
        expect(treeHashes(path.join(root, "dist"))).toEqual(published);
        expect(treeHashes(path.join(root, "packages/plugin-sdk/dist"))).toEqual(local);
        expectStagingClean(root);
        for (const diagnostic of diagnostics) {
          expect(failed.stdout + failed.stderr).toContain(diagnostic);
        }
      }),
  );
});
