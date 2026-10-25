import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readArtifactRecord } from "../../scripts/lib/build-artifact-cache.mts";
import { BOUNDARY_PLUGIN_UNITS } from "../../scripts/lib/extension-boundary-inputs.mts";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { runNodeStep } from "../../scripts/prepare-extension-package-boundary-artifacts.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  installNativeAncestorTypes,
  materializeNativeCompiler,
  resolveNativeFixtureShortPath,
  writeNativeFixtureFile,
} from "./native-boundary-fixture.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());
let preparationSources: string[] | undefined;
const boundaryRoot = ".artifacts/extension-package-boundary";
const sdkConfig = "packages/plugin-sdk/tsconfig.json";
const sdkOutput = "packages/plugin-sdk/dist";
const chosenConfig = `${boundaryRoot}/compile/chosen.tsconfig.json`;
const sdkCore = "src/plugin-sdk/core.ts";
const chosenEntry = "extensions/chosen/index.ts";
const chosenHelper = "extensions/chosen/excluded/helper.ts";
const moduleOptions = { target: "es2023", module: "nodenext", skipLibCheck: true, types: [] };
const isolatedCompilerArgs = [
  "--ignoreConfig",
  "--module",
  "nodenext",
  "--skipLibCheck",
  "--noEmit",
];

function command(root: string, bin: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(bin, args, { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  expect(result.error, result.stderr).toBeUndefined();
  return result;
}
function expectExit(result: ReturnType<typeof command>, status: number) {
  expect(result.status, result.stdout + result.stderr).toBe(status);
  return result.stdout;
}

function resolvePreparationSources() {
  // Keep source-key hashing and git indexing scoped to this fixture's executable graph.
  return (preparationSources ??= collectRuntimeImportClosure(
    process.cwd(),
    [
      "scripts/prepare-extension-package-boundary-artifacts.mts",
      "scripts/compile-extension-boundary.mts",
      "scripts/run-tsgo.mjs",
      "scripts/run-tsgo.mts",
      "scripts/generate-kysely-types.mts",
      "scripts/ci-sdk-declarations.mts",
      "scripts/check-extension-package-tsc-boundary.mts",
      "scripts/tsx.mjs",
      // These launchers are selected by URL rather than module imports.
      "scripts/lib/managed-memory-launcher.mts",
      "scripts/lib/managed-windows-job-launcher.mts",
    ],
    { includeDynamicImports: true },
  ));
}

function copyFixtureFiles(root: string, files: string[]) {
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.resolve(file), target, { recursive: true });
  }
}

function createPreparationFixture(mode: "package-boundary" | "all", signal: AbortSignal) {
  const ancestor = fs.realpathSync.native(fixture.createTempDir("native-preparer-"));
  const root = path.join(ancestor, ".claude/worktrees/validation");
  fs.mkdirSync(root, { recursive: true });
  const native = materializeNativeCompiler(root);
  const write = (file: string, text: string) => {
    signal.throwIfAborted();
    return writeNativeFixtureFile(root, file, text);
  };
  const json = (file: string, value: unknown) => write(file, JSON.stringify(value));
  const files = (entries: Record<string, unknown>) => {
    for (const [file, value] of Object.entries(entries)) {
      write(file, typeof value === "string" ? value : JSON.stringify(value));
    }
  };
  const read = (file: string) => fs.readFileSync(path.resolve(root, file), "utf8");
  const has = (file: string) => fs.existsSync(path.resolve(root, file));
  const snapshot = (file: string) => ({
    bytes: fs.readFileSync(path.resolve(root, file)),
    mtimeMs: fs.statSync(path.resolve(root, file)).mtimeMs,
  });
  const compile = (args: string[], status = 0) => {
    return expectExit(command(root, native, args), status);
  };
  const selected = (env?: NodeJS.ProcessEnv) => run(root, root, ["chosen"], env);
  write("package.json", '{"name":"openclaw","type":"module"}');
  write("pnpm-workspace.yaml", "packages: []\n");
  json("tsconfig.json", {
    compilerOptions: { ...moduleOptions, lib: ["es5"] },
  });
  json(sdkConfig, {
    extends: "../../tsconfig.json",
    include: ["../../src/**/*.ts"],
    exclude: ["../../src/shared/deferred.ts"],
  });
  write(sdkCore, 'export { value } from "../nested.js";');
  write("src/nested.ts", "export const value = 1;");
  copyFixtureFiles(root, [
    // Selected-consumer fixtures install their extra src/ tools with a narrowed SDK config.
    ...resolvePreparationSources().filter((file) => !file.startsWith("src/")),
    "src/shared/deferred.ts",
    "packages/normalization-core/package.json",
  ]);
  write("scripts/lib/plugin-sdk-entrypoints.json", '["core"]');
  for (const name of ["tsx", "@openclaw/fs-safe", "@openclaw/proc-safe"]) {
    const target = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.resolve("node_modules", name), target);
  }
  write(
    "packages/plugin-sdk/package.json",
    '{"name":"fixture-sdk","type":"module","types":"./dist/src/plugin-sdk/core.d.ts"}',
  );
  fs.symlinkSync("../packages/plugin-sdk", path.join(root, "node_modules/fixture-sdk"), "dir");
  const plugins = mode === "all" ? BOUNDARY_PLUGIN_UNITS : [];
  for (const [id, entry] of plugins) {
    const pluginRoot = `extensions/${id}`;
    files({
      [`${pluginRoot}/tsconfig.json`]: {
        extends: "../../tsconfig.json",
        files: [`${entry}.ts`],
      },
      [`${pluginRoot}/node_modules/boundary-private-dep/package.json`]: {
        name: "boundary-private-dep",
        types: "index.d.ts",
      },
      [`${pluginRoot}/node_modules/boundary-private-dep/index.d.ts`]:
        "export declare function consume(callback: (value: string) => string): void;",
      [`${pluginRoot}/${entry}.ts`]:
        'export { value } from "fixture-sdk"; export { consume } from "boundary-private-dep";',
    });
  }
  const recordPath = path.join(root, boundaryRoot, "plugin-sdk.json");
  const output = sdkOutput;
  const step = async (label: string, args: string[], bin?: string, env?: NodeJS.ProcessEnv) => {
    signal.throwIfAborted();
    // Expected compiler failures cancel only their own invocation, not later repair phases.
    const abortController = new AbortController();
    const abort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await fixture.track(runNodeStep(label, args, 30_000, { bin, env, abortController }));
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  const run = (declared = root, pwd = declared, extensionIds?: string[], env?: NodeJS.ProcessEnv) =>
    step(
      "native-fixture",
      [
        path.join(declared, "scripts/prepare-extension-package-boundary-artifacts.mts"),
        `--mode=${extensionIds ? "all" : mode}`,
        ...(extensionIds ? [`--extensions=${JSON.stringify(extensionIds)}`] : []),
      ],
      undefined,
      { ...env, PWD: pwd },
    );
  return {
    ancestor,
    root,
    native,
    write,
    json,
    files,
    read,
    has,
    snapshot,
    compile,
    selected,
    plugins,
    recordPath,
    output,
    step,
    run,
  };
}

function writeSelectedConsumer(f: ReturnType<typeof createPreparationFixture>) {
  copyFixtureFiles(f.root, [
    "scripts/check-file-utils.ts",
    "src/plugins/package-entrypoints.ts",
    "src/shared/non-packaged-plugin-dirs.ts",
  ]);
  f.files({
    [sdkConfig]: {
      extends: "../../tsconfig.json",
      include: ["../../src/plugin-sdk/**/*.ts", "../../src/**/*.d.ts"],
    },
    "tsconfig.json": {
      compilerOptions: {
        ...moduleOptions,
        paths: {
          "openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"],
          "@openclaw/memory-core/api.js": ["./extensions/memory-core/api.ts"],
          "@openclaw/qa-channel/api.js": ["./extensions/qa-channel/api.ts"],
        },
      },
    },
    "extensions/tsconfig.package-boundary.base.json": {
      extends: "../tsconfig.json",
      compilerOptions: {
        paths: {
          "openclaw/plugin-sdk/*": [`../${sdkOutput}/src/plugin-sdk/*.d.ts`],
          ...Object.fromEntries(
            ["memory-core", "qa-channel"].map((id) => [
              `@openclaw/${id}/api.js`,
              [`../${boundaryRoot}/plugins/${id}/api.d.ts`],
            ]),
          ),
        },
      },
    },
    "extensions/chosen/package.json": {
      name: "@openclaw/chosen",
      type: "module",
      openclaw: { extensions: ["./index.ts"] },
    },
    "extensions/chosen/openclaw.plugin.json": { id: "chosen" },
    "extensions/chosen/tsconfig.json": {
      extends: "../tsconfig.package-boundary.base.json",
      compilerOptions: { rootDir: "." },
      include: ["index.ts"],
      exclude: ["excluded/**"],
    },
    [chosenEntry]: 'export { value } from "./excluded/helper.js";',
    [chosenHelper]: 'export { value } from "openclaw/plugin-sdk/core";',
  });
}

function expectConsumerTypeError(f: ReturnType<typeof createPreparationFixture>, message: string) {
  expect(f.compile(["-p", chosenConfig, "--noEmit"], 2)).toContain(message);
}

describe("native declaration preparation", () => {
  it(
    "narrows SDK roots without weakening imports, ambient types, or full receipts",
    { timeout: 30_000 },
    ({ signal }) =>
      fixture.run(async () => {
        const f = createPreparationFixture("package-boundary", signal);
        writeSelectedConsumer(f);
        f.write("src/ambient.d.ts", "declare const fixtureAmbient: 'kept';");
        f.write("src/nested.ts", "export const value = fixtureAmbient;");
        f.write("src/plugin-sdk/unused.ts", "export const broken = ;");
        f.write("scripts/lib/plugin-sdk-entrypoints.json", '["core", "unused"]');
        await f.selected();
        const receipt = readArtifactRecord(f.recordPath)!;
        expect(receipt.inputs).toContain("src/nested.ts");
        expect(receipt.inputs).toContain("src/ambient.d.ts");
        expect(receipt.inputs).not.toContain("src/plugin-sdk/unused.ts");
        expect(f.read(`${f.output}/src/nested.d.ts`)).toContain('value: "kept"');
        const cold = f.snapshot(f.recordPath);
        await f.selected();
        expect(f.snapshot(f.recordPath)).toEqual(cold);

        f.write("src/plugin-sdk/added.ts", "export const added = 2;");
        f.write(
          chosenHelper,
          'export { value } from "openclaw/plugin-sdk/core"; export { added } from "openclaw/plugin-sdk/added";',
        );
        await f.selected();
        expect(readArtifactRecord(f.recordPath)?.inputs).toContain("src/plugin-sdk/added.ts");
        expect(f.has(`${f.output}/src/plugin-sdk/added.d.ts`)).toBe(true);

        await expect(f.run()).rejects.toThrow("failed with exit code 1");
        expect(f.has(f.recordPath)).toBe(false);
        f.write("src/plugin-sdk/unused.ts", "export const unused = 3;");
        await f.run();
        expect(f.has(`${f.output}/src/plugin-sdk/unused.d.ts`)).toBe(true);
        const full = f.snapshot(f.recordPath);
        await f.selected();
        expect(f.snapshot(f.recordPath)).toEqual(full);

        f.write(
          chosenEntry,
          'import { value } from "./excluded/helper.js"; export const wrong: number = value;',
        );
        expectConsumerTypeError(f, "Type 'string' is not assignable to type 'number'");
      }),
  );

  it.for([false, true])(
    "prepares transitive producers reached only through emitted SDK declarations (shared=%s)",
    { timeout: 30_000 },
    (sharedSdk, { signal }) =>
      fixture.run(async () => {
        const f = createPreparationFixture("package-boundary", signal);
        writeSelectedConsumer(f);
        f.files({
          "src/plugin-sdk/unused.ts": "export const unused = 7;",
          "scripts/lib/plugin-sdk-entrypoints.json": ["core", "unused"],
          [sdkCore]: 'export type { MemoryValue } from "@openclaw/memory-core/api.js";',
          [chosenHelper]: 'export type { MemoryValue } from "openclaw/plugin-sdk/core";',
          [chosenEntry]: 'export type { MemoryValue } from "./excluded/helper.js";',
          "extensions/memory-core/api.ts":
            'import type { ChannelValue } from "@openclaw/qa-channel/api.js"; export type MemoryValue = { channel: ChannelValue };',
          "extensions/qa-channel/api.ts": "export type ChannelValue = { text: string };",
        });
        for (const id of ["memory-core", "qa-channel"]) {
          f.json(`extensions/${id}/tsconfig.json`, {
            extends: "../tsconfig.package-boundary.base.json",
            files: ["api.ts"],
            include: [],
          });
        }
        const narrow = () => f.selected({ OPENCLAW_CI_SHARED_SDK: sharedSdk ? "1" : "0" });
        await narrow();
        expect(f.has(`${f.output}/src/plugin-sdk/unused.d.ts`)).toBe(sharedSdk);
        const outputs = ["memory-core", "qa-channel"].map((id) => {
          const record = path.join(f.root, `${boundaryRoot}/${id}.json`);
          expect(readArtifactRecord(record)).toBeDefined();
          expect(f.has(`${boundaryRoot}/plugins/${id}/api.d.ts`)).toBe(true);
          return { record, before: f.snapshot(record) };
        });
        f.compile(["-p", chosenConfig, "--noEmit"]);
        await narrow();
        for (const { record, before } of outputs) {
          expect(f.snapshot(record)).toEqual(before);
        }
      }),
  );

  it("reuses native receipts across Node minors while retaining major and generic-runtime fences", ({
    signal,
  }) =>
    fixture.run(async () => {
      const f = createPreparationFixture("package-boundary", signal);
      const preload = f.write(
        ".artifacts/advertise-node.cjs",
        'Object.defineProperty(process.versions, "node", { value: process.env.FIXTURE_NODE_VERSION });',
      );
      const genericEntry = f.write(
        ".artifacts/generic-signature.mts",
        'import { CompilerInputSnapshot } from "../scripts/lib/compiler-input-snapshot.mts";\n' +
          "const snapshot = new CompilerInputSnapshot(process.cwd(), { toolchainFiles: [], generatorInputs: [] });\n" +
          `console.log(snapshot.signature(${JSON.stringify(sdkConfig)}, [], []));\n`,
      );
      const major = Number(process.versions.node.split(".")[0]);
      const envFor = (version: string) => ({
        NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
        FIXTURE_NODE_VERSION: version,
      });
      const genericSignature = (version: string) => {
        return expectExit(
          command(f.root, process.execPath, [genericEntry], {
            ...process.env,
            ...envFor(version),
          }),
          0,
        ).trim();
      };
      const firstVersion = `${major}.19.0`;
      const minorVersion = `${major}.21.0`;
      await f.run(f.root, f.root, undefined, envFor(firstVersion));
      const receipt = f.snapshot(f.recordPath);
      const generic = genericSignature(firstVersion);
      await f.run(f.root, f.root, undefined, envFor(minorVersion));
      expect(f.snapshot(f.recordPath)).toEqual(receipt);
      expect(genericSignature(minorVersion)).not.toBe(generic);

      await f.run(f.root, f.root, undefined, envFor(`${major + 1}.0.0`));
      expect(readArtifactRecord(f.recordPath)?.signature).not.toBe(
        JSON.parse(receipt.bytes.toString()).signature,
      );
      expect(f.read(`${f.output}/src/nested.d.ts`)).toContain("value = 1");
    }));

  it("prepares the full shared SDK when the boundary checker selects no packages", ({ signal }) =>
    fixture.run(async () => {
      const f = createPreparationFixture("package-boundary", signal);
      copyFixtureFiles(f.root, [
        "scripts/check-extension-package-tsc-boundary.mts",
        "scripts/check-file-utils.ts",
        "src/plugins/package-entrypoints.ts",
        "src/shared/non-packaged-plugin-dirs.ts",
      ]);
      fs.symlinkSync(path.resolve("node_modules/p-map"), path.join(f.root, "node_modules/p-map"));
      fs.mkdirSync(path.join(f.root, "extensions"));
      f.json(sdkConfig, {
        extends: "../../tsconfig.json",
        include: ["../../src/plugin-sdk/**/*.ts"],
      });
      await f.step(
        "empty-boundary-selection",
        [path.join(f.root, "scripts/check-extension-package-tsc-boundary.mts"), "--mode=compile"],
        undefined,
        { OPENCLAW_CI_SHARED_SDK: "1", GITHUB_STEP_SUMMARY: undefined },
      );
      expect(readArtifactRecord(f.recordPath)?.inputs).toContain("src/nested.ts");
      expect(f.read(`${f.output}/src/nested.d.ts`)).toContain("value = 1");
    }));

  it(
    "transports only current full SDK receipts and validates restored bytes in another checkout",
    { timeout: 30_000 },
    ({ signal }) =>
      fixture.run(async () => {
        const setup = () => {
          const f = createPreparationFixture("package-boundary", signal);
          writeSelectedConsumer(f);
          f.write("src/plugin-sdk/unused.ts", "export const unused = 7;");
          f.write("scripts/lib/plugin-sdk-entrypoints.json", '["core", "unused"]');
          f.write(
            "scripts/ci-sdk-declarations.mts",
            fs.readFileSync("scripts/ci-sdk-declarations.mts", "utf8"),
          );
          f.write(".gitignore", "node_modules/\n.artifacts/\npackages/plugin-sdk/dist/\n");
          for (const args of [
            ["init", "-q"],
            ["add", "."],
          ]) {
            const git = spawnSync("git", args, { cwd: f.root, encoding: "utf8" });
            expect(git.status, git.stderr).toBe(0);
          }
          return f;
        };
        const producer = setup();
        const consumer = setup();
        const cli = (f: typeof producer, operation: string, ...args: string[]) => {
          signal.throwIfAborted();
          return command(
            f.root,
            process.execPath,
            ["scripts/ci-sdk-declarations.mts", operation, ...args],
            { ...process.env, GITHUB_OUTPUT: undefined },
          );
        };
        const success = (f: typeof producer, operation: string, ...args: string[]) => {
          const result = cli(f, operation, ...args);
          expectExit(result, 0);
          return result;
        };
        const identity = (
          f: typeof producer,
        ): { "cache-key": string; archive: string; fresh: string } =>
          JSON.parse(success(f, "key").stdout);

        await producer.selected();
        const narrowReceipt = producer.read(producer.recordPath);
        const narrowPack = cli(producer, "pack");
        expect(narrowPack.status, narrowPack.stdout + narrowPack.stderr).toBe(1);
        expect(narrowPack.stderr).toContain("Only a current full SDK receipt");
        await producer.run();
        success(producer, "pack");
        const published = identity(producer);
        const empty = identity(consumer);
        expect(published.fresh).toBe("true");
        expect(empty.fresh).toBe("false");
        expect(empty["cache-key"]).toBe(published["cache-key"]);
        expect(consumer.root).not.toBe(producer.root);
        const archive = fs.readFileSync(path.join(producer.root, published.archive));
        const targetArchive = path.join(consumer.root, published.archive);
        fs.mkdirSync(path.dirname(targetArchive), { recursive: true });
        fs.writeFileSync(targetArchive, archive);
        success(consumer, "restore", "--required");
        success(consumer, "validate");
        const restored = consumer.snapshot(consumer.recordPath);
        await consumer.selected({ OPENCLAW_CI_SHARED_SDK: "1" });
        expect(consumer.snapshot(consumer.recordPath)).toEqual(restored);
        consumer.write(
          chosenEntry,
          'import { value } from "./excluded/helper.js"; export const wrong: string = value;',
        );
        expectConsumerTypeError(consumer, "Type 'number' is not assignable to type 'string'");
        consumer.write(chosenEntry, 'export { value } from "./excluded/helper.js";');

        const payload: { version: number; key: string; files: [string, string][] } = JSON.parse(
          gunzipSync(archive).toString("utf8"),
        );
        const declaration = `${consumer.output}/src/nested.d.ts`;
        const record = `${boundaryRoot}/plugin-sdk.json`;
        const invalidArchives = [
          payload.files.map(([file, bytes]) => [
            file,
            file === declaration ? "export declare const value: string;" : bytes,
          ]),
          payload.files.filter(([file]) => file !== declaration),
          payload.files.filter(([file]) => file !== record),
          payload.files.map(([file, bytes]) => [file, file === record ? narrowReceipt : bytes]),
        ];
        for (const files of invalidArchives) {
          fs.rmSync(consumer.recordPath, { force: true });
          fs.rmSync(path.join(consumer.root, consumer.output), { recursive: true, force: true });
          fs.writeFileSync(targetArchive, gzipSync(JSON.stringify({ ...payload, files })));
          const rejected = cli(consumer, "restore", "--required");
          expect(rejected.status, rejected.stdout + rejected.stderr).toBe(1);
          expect(rejected.stderr).toMatch(/SDK (?:archive|receipt)/u);
          expect(consumer.has(consumer.recordPath)).toBe(false);
        }

        fs.writeFileSync(targetArchive, archive);
        success(consumer, "restore", "--required");
        consumer.write("src/nested.ts", "export const value = 2;");
        expect(identity(consumer)["cache-key"]).not.toBe(published["cache-key"]);
        expect(cli(consumer, "validate").status).toBe(1);
        const stale = cli(consumer, "restore", "--required");
        expect(stale.status, stale.stdout + stale.stderr).toBe(1);
        expect(stale.stderr).toContain("different source or toolchain inputs");
        expect(success(consumer, "restore").stdout).toContain("native preparation will run");
        expect(consumer.has(consumer.recordPath)).toBe(false);
        await consumer.run();
        success(consumer, "validate");
        expect(consumer.read(declaration)).toContain("value = 2");
      }),
  );

  it("publishes generated schema types for an isolated SDK consumer", ({ signal }) =>
    fixture.run(async () => {
      const f = createPreparationFixture("package-boundary", signal);
      for (const name of ["state", "agent"]) {
        f.write(
          `src/state/openclaw-${name}-schema.sql`,
          "CREATE TABLE records (title TEXT NOT NULL);",
        );
      }
      f.write(
        "src/state/openclaw-state-db.generated.ts",
        fs.readFileSync("src/state/openclaw-state-db.generated.ts", "utf8"),
      );
      f.write(sdkCore, 'export type { DB } from "../state/openclaw-state-db.generated.js";');
      fs.cpSync(fs.realpathSync("node_modules/kysely"), path.join(f.root, "node_modules/kysely"), {
        recursive: true,
      });
      await f.run();
      f.write(
        "consumer.ts",
        'import type { DB } from "fixture-sdk"; declare const row: DB["records"]; const wrong: number = row.title;',
      );
      expect(f.compile([...isolatedCompilerArgs, "consumer.ts"], 2)).toContain(
        "Type 'string' is not assignable to type 'number'",
      );
    }));

  it.for([
    { name: "Windows 8.3 short entry", entry: true, workspace: false },
    { name: "Windows 8.3 workspace junction", entry: false, workspace: true },
    { name: "POSIX PWD alias (all)", mode: "all" as const },
  ])(
    "publishes cold native output and reuses warm receipts through $name",
    { timeout: 30_000 },
    ({ entry, workspace, mode }, context) => {
      if (mode ? process.platform === "win32" : process.platform !== "win32") {
        return context.skip("Checkout alias is specific to another platform");
      }
      const f = createPreparationFixture(mode ?? "package-boundary", context.signal);
      let declared = f.root;
      if (mode) {
        declared = path.join(f.ancestor, "declared-alias");
        fs.symlinkSync(f.root, declared, "dir");
        expect(fs.realpathSync.native(declared)).toBe(f.root);
      }
      if (entry) {
        const short = resolveNativeFixtureShortPath(f.root);
        if (!short) {
          return context.skip("Filesystem does not expose a distinct Windows 8.3 checkout alias");
        }
        declared = short;
        expect(fs.realpathSync(declared)).not.toBe(f.root);
        expect(fs.realpathSync.native(declared)).toBe(f.root);
      }
      if (workspace) {
        const sdk = path.join(f.root, "packages/plugin-sdk");
        const short = resolveNativeFixtureShortPath(sdk);
        if (!short) {
          return context.skip("Filesystem does not expose a distinct Windows 8.3 workspace alias");
        }
        const link = path.join(f.root, "node_modules/fixture-sdk");
        fs.unlinkSync(link);
        fs.symlinkSync(short, link, "junction");
        expect(fs.realpathSync(link)).not.toBe(sdk);
        expect(fs.realpathSync.native(link)).toBe(sdk);
      }
      return fixture.run(async () => {
        // Relative CLI entry paths use Node's physical cwd while Go can retain shell PWD.
        const cold = await f
          .run(mode ? f.root : declared, declared)
          .catch((error: unknown) => error);
        // Even the failing-before case must reach real native emit, not fail during setup.
        expect(f.read(`${f.output}/src/nested.d.ts`)).toContain("value = 1");
        const receipt: { inputs: string[] } = JSON.parse(f.read(`${f.output}/.inputs.json`));
        expect(receipt.inputs).toContain("src/nested.ts");
        expect(cold).toBeUndefined();
        expect(readArtifactRecord(f.recordPath)?.inputs).toContain("src/nested.ts");
        const owners = [
          {
            recordPath: f.recordPath,
            output: f.output,
            files: [".inputs.json", "src/nested.d.ts", "src/plugin-sdk/core.d.ts"],
          },
          ...f.plugins.map(([id, pluginEntry]) => ({
            recordPath: path.join(f.root, `${boundaryRoot}/${id}.json`),
            output: `${boundaryRoot}/plugins/${id}`,
            files: [".inputs.json", `${pluginEntry}.d.ts`],
          })),
        ];
        const artifacts = owners.flatMap((owner) => {
          const outputs = owner.files.map((file) => `${owner.output}/${file}`);
          expect(Object.keys(readArtifactRecord(owner.recordPath)!.outputs).toSorted()).toEqual(
            outputs.toSorted(),
          );
          return [owner.recordPath, ...outputs].map((file) => ({ file, before: f.snapshot(file) }));
        });
        for (const spelling of [declared, f.root]) {
          await f.run(mode ? f.root : spelling, spelling);
          for (const { file, before } of artifacts) {
            expect(f.snapshot(file)).toEqual(before);
          }
        }
      });
    },
  );

  it.for([false, true])(
    "refuses a shared install before creating dependency links or receipts (linked=%s)",
    (linked, { signal }) => {
      const f = createPreparationFixture("package-boundary", signal);
      expect(spawnSync("git", ["init", "-q"], { cwd: f.ancestor }).status).toBe(0);
      f.write(".git", `gitdir: ${path.join(f.ancestor, ".git")}\n`);
      const modules = path.join(f.root, "node_modules");
      const primaryModules = path.join(f.ancestor, "node_modules");
      fs.renameSync(modules, primaryModules);
      if (linked) {
        fs.symlinkSync(primaryModules, modules, "junction");
      }
      const result = command(f.root, process.execPath, [
        path.join(f.root, "scripts/prepare-extension-package-boundary-artifacts.mts"),
        "--mode=package-boundary",
      ]);
      expectExit(result, 1);
      expect(result.stderr).toContain("Declaration input escapes checkout");
      expect(fs.existsSync(modules)).toBe(linked);
      expect(f.has(f.recordPath)).toBe(false);
      expect(f.has(".artifacts/dist-artifacts.lock/owner.json")).toBe(false);
    },
  );

  it(
    "preserves outputs on compile failure and prunes obsolete declarations after repair",
    { timeout: 30_000 },
    ({ signal }) =>
      fixture.run(async () => {
        const { root, native, write, read, has, plugins, recordPath, output, step, run } =
          createPreparationFixture("all", signal);
        await run();
        const slackBoundaryEntry = BOUNDARY_PLUGIN_UNITS.find(([id]) => id === "slack")?.[1];
        if (!slackBoundaryEntry) {
          throw new Error("Slack extension boundary entry is missing");
        }
        write(
          "consumer.ts",
          `import { consume } from "./.artifacts/extension-package-boundary/plugins/slack/${slackBoundaryEntry}.js"; consume(value => value.toUpperCase());`,
        );
        await step(
          "isolated-boundary-consumer",
          [
            ...isolatedCompilerArgs,
            "--target",
            "es2023",
            "--strict",
            path.join(root, "consumer.ts"),
          ],
          native,
        );
        const first = readArtifactRecord(recordPath)!;
        expect(first.outputs[`${output}/src/nested.d.ts`]).toBeDefined();
        write(sdkCore, 'export { value } from "../renamed.js";');
        fs.renameSync(path.join(root, "src/nested.ts"), path.join(root, "src/renamed.ts"));
        write(`${output}/orphan.d.ts`, "export {};");
        write(`${output}/operator-note.txt`, "unowned");
        for (const invalid of [
          'export const value: number = "error";',
          "export const value = class { private field = 1; };",
        ]) {
          write("src/renamed.ts", invalid);
          await expect(run()).rejects.toThrow("failed with exit code 1");
          signal.throwIfAborted();
          expect(fs.readdirSync(path.join(root, ".artifacts/dist-artifacts.lock"))).toEqual([]);
          expect(has(recordPath)).toBe(false);
          expect(has(`${output}/src/renamed.d.ts`)).toBe(false);
          expect(has(`${output}/.inputs.json`)).toBe(false);
          expect(has(`${output}/src/nested.d.ts`)).toBe(true);
        }
        write("src/renamed.ts", "export const value = 2;");
        await run();
        const repaired = readArtifactRecord(recordPath)!;
        expect(repaired.outputs[`${output}/src/renamed.d.ts`]).toBeDefined();
        expect(repaired.outputs[`${output}/src/nested.d.ts`]).toBeUndefined();
        expect(has(`${output}/src/nested.d.ts`)).toBe(false);
        expect(has(`${output}/orphan.d.ts`)).toBe(false);
        expect(read(`${output}/operator-note.txt`)).toBe("unowned");
        for (const [id, entry] of plugins) {
          const record = readArtifactRecord(path.join(root, `${boundaryRoot}/${id}.json`))!;
          expect(record.inputs).toContain(`${output}/src/renamed.d.ts`);
          expect(record.outputs[`${boundaryRoot}/plugins/${id}/${entry}.d.ts`]).toBeDefined();
        }
      }),
  );

  it.for(["SDK", "plugin batch"] as const)(
    "isolates the %s from ancestor types and rejects ancestor-only dependencies without pruning",
    { timeout: 30_000 },
    (owner, { signal }) =>
      fixture.run(async () => {
        const f = createPreparationFixture(owner === "SDK" ? "package-boundary" : "all", signal);
        await f.run();
        installNativeAncestorTypes(f.ancestor, f.root);
        const [pluginId, entry] = BOUNDARY_PLUGIN_UNITS[0];
        const input = owner === "SDK" ? sdkCore : `extensions/${pluginId}/${entry}.ts`;
        const config = owner === "SDK" ? sdkConfig : `extensions/${pluginId}/tsconfig.json`;
        const rootDir = owner === "SDK" ? "." : `extensions/${pluginId}`;
        const emitted = owner === "SDK" ? "src/plugin-sdk/core.d.ts" : `${entry}.d.ts`;
        const output = owner === "SDK" ? f.output : `${boundaryRoot}/plugins/${pluginId}`;
        f.write(
          input,
          'import type { Marker } from "synthetic-wrapper";\nexport type { Marker };\nexport const inferredOrigin = declarationOrigin;\n',
        );
        const units =
          owner === "SDK"
            ? [{ id: "plugin-sdk", output: f.output }]
            : f.plugins.map(([id]) => ({
                id,
                output: `${boundaryRoot}/plugins/${id}`,
              }));
        for (const unit of units) {
          f.write(`${unit.output}/orphan.d.ts`, "export interface Orphan {}\n");
        }
        const rawOutput = path.join(f.root, ".artifacts/native-proof");
        await f.step(
          "raw-native-success",
          [
            "-p",
            path.join(f.root, config),
            "--declaration",
            "true",
            "--emitDeclarationOnly",
            "true",
            "--noEmit",
            "false",
            "--outDir",
            rawOutput,
            "--rootDir",
            path.join(f.root, rootDir),
            "--incremental",
            "--tsBuildInfoFile",
            path.join(rawOutput, ".tsbuildinfo"),
          ],
          f.native,
        );
        expect(fs.readFileSync(path.join(rawOutput, emitted), "utf8")).toContain(
          'inferredOrigin: "ancestor"',
        );

        await f.run();
        expect(f.read(`${output}/${emitted}`)).toContain('inferredOrigin: "local"');
        for (const unit of units) {
          expect(
            readArtifactRecord(path.join(f.root, `${boundaryRoot}/${unit.id}.json`)),
          ).toBeDefined();
          expect(f.has(`${unit.output}/orphan.d.ts`)).toBe(false);
          f.write(`${unit.output}/orphan.d.ts`, "export interface Orphan {}\n");
        }
        fs.rmSync(
          path.join(
            f.root,
            "node_modules/.pnpm/core/node_modules/@types/synthetic-core/index.d.ts",
          ),
        );

        // A missing local type cannot fall through to the ancestor installation.
        // Every batch member must seal before any obsolete declaration is pruned.
        await expect(f.run()).rejects.toThrow("failed with exit code 1");
        for (const unit of units) {
          expect(f.has(`${boundaryRoot}/${unit.id}.json`)).toBe(false);
          expect(f.read(`${unit.output}/orphan.d.ts`)).toBe("export interface Orphan {}\n");
        }
        expect(f.has(".artifacts/dist-artifacts.lock/owner.json")).toBe(false);
      }),
  );
});
