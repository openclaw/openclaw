import fs from "node:fs";
import path from "node:path";
import { describe, expect, vi } from "vitest";
import { TSDOWN_UNIFIED_DTS_CONFIG_GROUPS } from "../../scripts/lib/tsdown-config-groups.mts";
import { resolveTsdownDeclarationGeneratorInputs } from "../../scripts/lib/tsdown-declaration-generator-inputs.mts";
import {
  createDeclarationFixture as createFixture,
  createDeclarationTest,
  declarationCacheRecords,
  declarationInputs,
  expectStagingClean,
  runFixture,
  runUnifiedBuild,
  runUnifiedWriter,
  treeHashes,
} from "./tsdown-declaration-fixture.js";

const it = createDeclarationTest();
const generatorInputs = () =>
  resolveTsdownDeclarationGeneratorInputs(process.cwd(), "scripts/write-unified-entry-dts.ts");

function expectInvalidSource(file: string, transform: (source: string) => string, message: string) {
  const readFileSync = fs.readFileSync.bind(fs);
  const read = vi.spyOn(fs, "readFileSync").mockImplementation((candidate, options) => {
    const contents = readFileSync(candidate, options);
    return typeof contents === "string" && String(candidate).endsWith(file)
      ? transform(contents)
      : contents;
  });
  try {
    expect(generatorInputs).toThrow(message);
  } finally {
    read.mockRestore();
  }
}

describe("write-unified-entry-dts", () => {
  it("owns the executable generator closure without unrelated CI planning code", () => {
    const root = process.cwd();
    const closure = generatorInputs().map((file) =>
      path.relative(root, file).split(path.sep).join("/"),
    );

    expect(closure).toEqual(
      expect.arrayContaining([
        "scripts/lib/tsdown-declaration-generator-inputs.mts",
        "scripts/lib/tsdown-declaration-boundary.mts",
        "scripts/lib/plugin-sdk-entrypoints.json",
        "scripts/windows-cmd-helpers.mjs",
        "packages/normalization-core/src/mountinfo-path.ts",
        "src/infra/runtime-process-manifest.ts",
        "src/state/openclaw-state-schema.sql",
        "src/state/openclaw-agent-schema.sql",
        "src/state/postgres-schema.generated/sqlite-state-catalogs.json",
        "src/shared/freebsd-process-identity.ts",
        "src/infra/update-managed-service-handoff-native-loader.ts",
        "src/infra/package-update-activation-native-loader.ts",
      ]),
    );
    expect(closure).not.toContain("scripts/lib/ci-node-test-plan.mts");
    expect(closure).not.toContain("src/infra/node_modules/@openclaw/proc-safe/dist/identity.js");
  });

  it("still traverses a compiler source when the generator also imports it", () => {
    expectInvalidSource(
      "managed-handoff-build-config.mts",
      (contents) =>
        `${contents}\nimport "../../src/infra/update-managed-service-handoff-native-loader.ts";\n`,
      "Unresolved dynamic module edges in src/infra/update-managed-service-handoff-native-loader.ts",
    );
  });

  it.each([
    ["unowned dynamic", "\nvoid import(generatorTarget);\n", "Unresolved dynamic module edges"],
    ["unresolved static", '\nimport "./missing-generator-owner.mts";\n', "Unresolved import"],
  ])("rejects an %s edge in the real generator graph", (_name, injected, message) => {
    expectInvalidSource("numeric-options.mjs", (contents) => `${contents}${injected}`, message);
  });

  it("rejects a same-count computed import retarget", () => {
    expectInvalidSource(
      "tsx-cli-shim.mjs",
      (contents) =>
        contents.replace("resolveTsxImport(SHIM_CHECKOUT_ROOT)", "resolveTsxImport(process.cwd())"),
      "Unresolved dynamic module edges",
    );
  });

  it("leaves physical and external installed dependencies to lockfile topology", () => {
    const root = process.cwd();
    const list = () =>
      resolveTsdownDeclarationGeneratorInputs(root, "scripts/write-unified-entry-dts.ts").map(
        (file) => path.relative(root, file).split(path.sep).join("/"),
      );
    expect(list().some((file) => file.endsWith("/typescript/lib/typescript.d.ts"))).toBe(false);

    const realpathSync = fs.realpathSync.bind(fs);
    const realpath = vi.spyOn(fs, "realpathSync").mockImplementation((file, options) => {
      const name = String(file).replaceAll("\\", "/");
      return name.endsWith("/node_modules/typescript/lib/typescript.d.ts")
        ? path.join(root, "node_modules/typescript/lib/typescript.d.ts")
        : realpathSync(file, options as never);
    });
    try {
      expect(list().some((file) => file.endsWith("/typescript/lib/typescript.d.ts"))).toBe(false);
    } finally {
      realpath.mockRestore();
    }
  });

  it("compiles declarations once and restores them while rebuilding runtime after input edits", ({
    command,
  }) =>
    command.lifetime.run(async () => {
      const { root, write, production, declarations } = createFixture(
        command,
        TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
      );
      const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
      const exists = (file: string) => fs.existsSync(path.join(root, file));
      const hashDist = () => treeHashes(path.join(root, "dist"));
      const runBuild = async (invocations: number) => {
        const result = await runUnifiedBuild(command, root, runtimeConfig);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(
          (result.stdout + result.stderr).match(/\[tsdown-build\] invocation \d\/\d finished/gu),
        ).toHaveLength(invocations);
      };
      expect(Object.values(declarations).every((entries) => entries.length > 0)).toBe(true);
      expect(production).toHaveLength(Object.values(declarations).flat().length);
      const pluginFile = (file: string) => `extensions/fixture-a/${file}`;
      write(pluginFile("runtime-only.js"), 'export const runtimeOnly = "runtime";');
      write(pluginFile("typed-runtime.js"), 'export const typedRuntime = "typed";');
      write(pluginFile("typed-runtime.d.ts"), 'export declare const typedRuntime: "typed";');
      fs.appendFileSync(
        path.join(root, "extensions/fixture-a/index.ts"),
        [
          '\nexport const pluginRevision = "fixture_zeta";',
          'export function literalOrder(flag: boolean) { return flag ? "fixture_alpha" as const : "fixture_zeta" as const; }',
          'export { typedRuntime } from "./typed-runtime.js";',
        ].join("\n"),
      );
      // Preserve external type compatibility when another entry changes.
      fs.appendFileSync(
        path.join(root, "extensions/fixture-b/index.ts"),
        [
          '\nexport type { Schema as ArrowSchema } from "apache-arrow";',
          'export type { Message as ArrowMessage } from "apache-arrow/ipc/metadata/message";',
        ].join("\n"),
      );
      const preserved = {
        "dist/control-ui/retained.d.ts": "Vite-owned declaration",
        "dist/releases/Previous.app/Contents/Resources/core.d.ts": "signed app declaration",
        "packages/plugin-sdk/dist/retained.d.ts": "native boundary declaration",
      };
      for (const [file, bytes] of Object.entries(preserved)) {
        write(file, bytes);
      }
      write("dist/obsolete.d.ts", "obsolete root declaration");
      write("dist/extensions/removed/api.d.ts", "obsolete plugin declaration");
      write(
        "consumer.ts",
        [
          'import type { Schema } from "apache-arrow";',
          'import type { Message } from "apache-arrow/ipc/metadata/message";',
          'import type { ArrowSchema, ArrowMessage } from "./dist/extensions/fixture-b/index.js";',
          "declare const schema: Schema; const projectedSchema: ArrowSchema = schema;",
          "const originalSchema: Schema = projectedSchema; void originalSchema;",
          "declare const message: Message; const projectedMessage: ArrowMessage = message;",
          "const originalMessage: Message = projectedMessage; void originalMessage;",
          "declare const encode: typeof Schema.encode; const projectedEncode: typeof ArrowSchema.encode = encode; void projectedEncode;",
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
      // Declaration reuse needs the shared runtime graph, not unrelated standalone workers.
      const runtimeConfig = "tsdown.fixture-runtime.config.ts";
      write(
        runtimeConfig,
        `import configs from "./tsdown.config.ts";
export default configs.filter(config => Object.hasOwn(config.entry ?? {}, "index"));
`,
      );
      await runBuild(2);
      for (const entry of production) {
        expect(fs.statSync(path.join(root, `dist/${entry}.d.ts`)).size, entry).toBeGreaterThan(0);
      }
      const readPluginDeclaration = () => read("dist/extensions/fixture-a/index.d.ts");
      const originalFunction = readPluginDeclaration().match(
        /^(?:export )?declare function literalOrder\(.*;$/mu,
      )?.[0];
      expect(originalFunction).toBeDefined();
      const consumer = await runFixture(command, root, [
        path.resolve("scripts/run-tsgo.mjs"),
        "-p",
        "consumer.json",
        "--noEmit",
      ]);
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(0);
      for (const name of ["runtime-only", "typed-runtime"]) {
        expect(
          fs.statSync(path.join(root, `dist/extensions/fixture-a/${name}.js`)).size,
        ).toBeGreaterThan(0);
        expect(exists(`dist/extensions/fixture-a/${name}.d.ts`)).toBe(false);
      }
      expect(exists("dist/obsolete.d.ts")).toBe(false);
      expect(exists("dist/extensions/removed/api.d.ts")).toBe(false);
      for (const [file, bytes] of Object.entries(preserved)) {
        expect(read(file)).toBe(bytes);
      }
      const cache = path.join(root, ".artifacts/build-all-cache");
      const records = declarationCacheRecords(root);
      const inputs = records.flatMap((record) => record.inputs ?? []);
      expect(inputs).toEqual(
        expect.arrayContaining([
          "src/shared.ts",
          "extensions/fixture-a/typed-runtime.d.ts",
          ...declarationInputs.map(({ file }) => file),
        ]),
      );
      expect(inputs).not.toContain("test/unrelated.test.ts");
      expect(inputs).not.toContain("ui/unrelated.ts");
      expect(
        records
          .flatMap((record) => Object.keys(record.outputs))
          .some((file) => file.includes(".app/") || file.includes("control-ui/")),
      ).toBe(false);
      const cached = treeHashes(cache);
      const before = hashDist();
      write("test/unrelated.test.ts", "export const test = 2;\n");
      write("ui/unrelated.ts", "export const view = 2;\n");
      write(".github/workflows/unrelated.yml", "name: unrelated after\n");
      fs.appendFileSync(
        path.join(root, "scripts/lib/ci-node-test-plan.mts"),
        "\n// Unrelated CI planning edit.\n",
      );
      fs.rmSync(path.join(root, "dist"), { recursive: true });
      for (const [file, bytes] of Object.entries(preserved)) {
        write(file, bytes);
      }
      await runBuild(1);
      expect(hashDist()).toEqual(before);
      expect(treeHashes(cache)).toEqual(cached);
      const pluginInput = "extensions/fixture-a/index.ts";
      // A prior literal allocation must not reorder the unchanged function's public type.
      write(
        pluginInput,
        read(pluginInput).replace(
          'pluginRevision = "fixture_zeta"',
          'pluginRevision = "fixture_alpha"',
        ),
      );
      await runBuild(2);
      expect(records).toHaveLength(TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.length);
      expect(records.filter((record) => record.inputs?.includes(pluginInput))).toHaveLength(1);
      expect(records.filter((record) => record.inputs?.includes("src/shared.ts"))).toHaveLength(
        TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.length,
      );
      const changedDeclaration = readPluginDeclaration();
      expect(changedDeclaration).toContain('pluginRevision = "fixture_alpha"');
      expect(
        changedDeclaration.match(/^(?:export )?declare function literalOrder\(.*;$/mu)?.[0],
      ).toBe(originalFunction);
      const changedCacheGroups = new Set(
        Object.entries(treeHashes(cache))
          .filter(([file, digest]) => cached[file] !== digest)
          .map(([file]) => file.split("/")[0]),
      );
      expect(changedCacheGroups.size).toBe(1);
      const mixedGeneration = hashDist();
      const cold = await runUnifiedWriter(command, root, { OPENCLAW_BUILD_CACHE: "0" });
      expect(cold.status, cold.stdout + cold.stderr).toBe(0);
      expect(
        (cold.stdout + cold.stderr).match(/\[tsdown-build\] invocation \d\/1 finished/gu),
      ).toHaveLength(1);
      expect(hashDist()).toEqual(mixedGeneration);
      expectStagingClean(root);
    }));

  it.concurrent("caches the complete declaration program for a bounded plugin selection", ({
    command,
  }) =>
    command.lifetime.run(async () => {
      const { root, write } = createFixture(command, TSDOWN_UNIFIED_DTS_CONFIG_GROUPS);
      for (const [file, marker, flag] of [
        [
          "scripts/lib/tsdown-declaration-generator-inputs.mts",
          '  configEntry = "tsdown.config.ts",\n) {',
          "DECLARATION_TEST_DENY_CACHE_SNAPSHOT",
        ],
        [
          "scripts/lib/compiler-input-snapshot.mts",
          "constructor(rootDir: string, policy: CompilerInputPolicy) {",
          "DECLARATION_TEST_DENY_CACHE_SNAPSHOT",
        ],
        [
          "scripts/tsdown-build.mts",
          "  const args = params.args ?? [];\n  const plan = resolveTsdownBuildPlan(params);",
          "DECLARATION_TEST_DENY_COMPILER_PLAN",
        ],
      ] as const) {
        const current = fs.readFileSync(path.join(root, file), "utf8");
        expect(current).toContain(marker);
        write(
          file,
          current.replace(
            marker,
            marker +
              "\nif (process.env[" +
              JSON.stringify(flag) +
              '] === "1") throw new Error("Unexpected declaration preparation");\n',
          ),
        );
      }
      const env = { OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "fixture-a" };
      const initial = await runUnifiedWriter(command, root, env);
      expect(initial.status, initial.stdout + initial.stderr).toBe(0);
      for (const group of TSDOWN_UNIFIED_DTS_CONFIG_GROUPS) {
        expect(initial.stderr).toContain(
          `[tsdown-unified] ${group}: cache miss (record-unavailable)`,
        );
      }
      expect(
        (initial.stdout + initial.stderr).match(/\[tsdown-build\] invocation \d\/1 finished/gu),
      ).toHaveLength(1);
      expect(fs.existsSync(path.join(root, "dist/extensions/fixture-a/index.d.ts"))).toBe(true);
      expect(fs.existsSync(path.join(root, "dist/extensions/fixture-b/index.d.ts"))).toBe(false);
      const before = treeHashes(path.join(root, "dist"));
      const repeated = await runUnifiedWriter(command, root, {
        ...env,
        DECLARATION_TEST_DENY_COMPILER_PLAN: "1",
      });
      expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0);
      for (const group of TSDOWN_UNIFIED_DTS_CONFIG_GROUPS) {
        expect(repeated.stderr).toContain(`[tsdown-unified] ${group}: cache hit (fresh-cache)`);
      }
      expect(repeated.stdout + repeated.stderr).not.toContain("[tsdown-build] invocation");
      expect(treeHashes(path.join(root, "dist"))).toEqual(before);
      const cached = treeHashes(path.join(root, ".artifacts/build-all-cache"));
      const uncached = await runUnifiedWriter(command, root, {
        ...env,
        OPENCLAW_BUILD_CACHE: "0",
        DECLARATION_TEST_DENY_CACHE_SNAPSHOT: "1",
      });
      expect(uncached.status, uncached.stdout + uncached.stderr).toBe(0);
      expect(treeHashes(path.join(root, "dist"))).toEqual(before);
      expect(treeHashes(path.join(root, ".artifacts/build-all-cache"))).toEqual(cached);
      expectStagingClean(root);
    }));

  it.concurrent.for([
    "compiler failure",
    "missing successful receipt",
    "missing successful receipt without cache",
  ])("preserves the previous generation on %s", (failure, { command }) =>
    command.lifetime.run(async () => {
      const { root, write, declarations } = createFixture(
        command,
        TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
      );
      const cacheDisabled = failure === "missing successful receipt without cache";
      write("dist/index.d.ts", "previous root declaration");
      write("dist/extensions/retained/index.d.ts", "previous plugin declaration");
      const before = treeHashes(path.join(root, "dist"));
      const cached: Record<string, string> = {};
      const last = TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.at(-1)!;
      if (failure === "compiler failure") {
        write(declarations[last]![0]!, 'export type { Missing } from "@openclaw/llm-core";');
      } else {
        write(
          "tsdown.config.ts",
          `${fs.readFileSync(path.join(root, "tsdown.config.ts"), "utf8")}
const selected = configs.find(config => config.name === ${JSON.stringify(last)});
const register = selected.hooks;
selected.hooks = async hooks => {
  await register(hooks);
  hooks.clearHook("build:done");
};
`,
        );
      }
      const failed = await runUnifiedWriter(
        command,
        root,
        cacheDisabled ? { OPENCLAW_BUILD_CACHE: "0" } : {},
      );
      expect(failed.status, failed.stdout + failed.stderr).toBeGreaterThan(0);
      expect(failed.stdout + failed.stderr).toContain("invocation 1/1 finished");
      expect(failed.stdout + failed.stderr).toContain(
        failure === "compiler failure" ? "TS2305" : "Missing successful compiler membership",
      );
      expect(treeHashes(path.join(root, "dist"))).toEqual(before);
      const cacheDirectory = path.join(root, ".artifacts/build-all-cache");
      if (cacheDisabled) {
        expect(fs.existsSync(cacheDirectory)).toBe(false);
      } else {
        expect(treeHashes(cacheDirectory)).toEqual(cached);
      }
      expectStagingClean(root);
    }),
  );
});
