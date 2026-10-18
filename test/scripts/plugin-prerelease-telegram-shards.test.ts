import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  createExtensionTestShards,
  listExtensionTestFilesForRoots,
  splitExtensionTestJobTargets,
} from "../../scripts/lib/extension-test-plan.mts";
import { createVitestRunSpecs } from "../../scripts/test-projects.test-support.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { codexExtensionTestRoots } from "../vitest/vitest.extension-codex-paths.mjs";
import { createExtensionVitestConfig } from "../vitest/vitest.extension-config.ts";
import { createExtensionDatabaseWorkersVitestConfig } from "../vitest/vitest.extension-database-workers.config.ts";
import { createExtensionTelegramVitestConfig } from "../vitest/vitest.extension-telegram.config.ts";
import {
  createPrereleaseFixtures,
  findStep,
  parseExtensionMatrix,
  parseManifestOutputs,
  readWorkflow,
} from "./plugin-prerelease.test-support.js";

const testNodeExecPath = resolveTestNodeExecPath();
const fixtures = createPrereleaseFixtures();
const telegramConfig = "test/vitest/vitest.extension-telegram.config.ts";
const databaseConfig = "test/vitest/vitest.extension-database-workers.config.ts";

const frozenRoot = fileURLToPath(
  new URL("../fixtures/plugin-prerelease-frozen-target/", import.meta.url),
);

function listRunnableExtensionTestFiles(worker = false, extensionId = "telegram") {
  const testConfig =
    (worker
      ? createExtensionDatabaseWorkersVitestConfig({})
      : extensionId === "codex"
        ? createExtensionVitestConfig("codex", codexExtensionTestRoots, {})
        : createExtensionTelegramVitestConfig({})
    ).test ?? {};
  const dir = testConfig.dir ?? process.cwd();
  const exclude = (testConfig.exclude ?? []).map((pattern) =>
    path.isAbsolute(pattern) ? path.relative(dir, pattern).replaceAll("\\", "/") : pattern,
  );
  return globSync(testConfig.include ?? [], { cwd: dir, exclude })
    .map((file) => path.relative(process.cwd(), path.resolve(dir, file)).replaceAll("\\", "/"))
    .filter((file) => file.startsWith(`extensions/${extensionId}/`))
    .toSorted((left, right) => left.localeCompare(right));
}

function runPluginPrereleaseManifest(cwd = process.cwd(), fullReleaseValidation = false) {
  const manifestStep = findStep(readWorkflow().jobs.preflight, "Build plugin prerelease manifest");
  const source = expectDefined(
    manifestStep?.run?.match(
      /node --import tsx --input-type=module <<'EOF'\n([\s\S]*?)\nEOF/u,
    )?.[1],
    "plugin prerelease manifest source",
  );
  const root = fixtures.make("openclaw-plugin-prerelease-telegram-shards-");
  const outputPath = join(root, "github-output");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EXPECTED_SHA: "",
    FULL_RELEASE_VALIDATION: String(fullReleaseValidation),
    GITHUB_OUTPUT: outputPath,
    OPENCLAW_CI_TEST_RUNTIME_POLICY: "",
  };
  delete env.OPENCLAW_VITEST_INCLUDE_FILE;
  const result = spawnSync(testNodeExecPath, ["--import", "tsx", "--input-type=module"], {
    cwd,
    encoding: "utf8",
    env,
    input: source,
  });
  expect(result.status, result.stderr).toBe(0);
  const output = parseManifestOutputs(readFileSync(outputPath, "utf8"));
  return { include: parseExtensionMatrix(output.plugin_prerelease_extension_matrix) };
}

describe("plugin prerelease Telegram extension shards", () => {
  it("preserves target-native batches when a frozen planner has no job splitter", () => {
    const matrix = runPluginPrereleaseManifest(frozenRoot, true);
    const batchRows = matrix.include.filter((row) => row.task === "extensions-batch");

    expect(existsSync(join(frozenRoot, "test/vitest/vitest.extension-telegram.config.mjs"))).toBe(
      true,
    );
    expect(matrix.include.every((row) => row.task !== "extension-file-shard")).toBe(true);
    expect(batchRows).toMatchObject(
      ["alpha,telegram", "zeta"].map((extensions_csv, index) => ({
        extensions_csv,
        check_name: `checks-node-extensions-shard-${index + 1}`,
        test_runtime_policy: "node",
        requires_bun: false,
      })),
    );
  });

  it("supplements manifest-only and root tests for an older package-only planner", () => {
    const sourceTest = "extensions/source-only/index.test.ts";
    const rootTest = "extensions/root.test.ts";
    const root = fixtures.target(
      "openclaw-prerelease-source-owner-",
      {
        "scripts/lib/extension-test-plan.mjs": `
import {globSync} from 'node:fs';
export const DEFAULT_EXTENSION_TEST_SHARD_COUNT=1;
export function createExtensionTestShards({extensionIds=['packaged']}={}) {
  return extensionIds.filter(id=>id==='packaged').map(id=>({
    checkName:'packaged',extensionIds:[id],index:0,
    planGroups:[{config:'test/vitest/extensions.mjs',roots:['extensions/'+id]}],
  }));
}
export const listExtensionTestFilesForRoots=roots=>roots.flatMap(root=>globSync(root+'/**/*.test.ts'));
export const resolveExtensionTestConfig=()=> 'test/vitest/extensions.mjs';
export const splitExtensionTestJobTargets=(_config,files)=>[files];
`,
        "scripts/lib/bundled-plugin-source-utils.mjs": `
export const collectBundledPluginSources=()=>[{dirName:'source-only',manifestPath:'extensions/source-only/openclaw.plugin.json'}];
`,
        "test/vitest/extensions.mjs":
          "export default {test:{include:['extensions/**/*.test.ts']}};\n",
        [sourceTest]: "",
        [rootTest]: "",
        "extensions/packaged/index.test.ts": "",
      },
      "junction",
    );
    const matrix = runPluginPrereleaseManifest(root, true);
    expect(
      matrix.include
        .filter((row) => row.task === "extensions-batch")
        .map((row) => row.extensions_csv),
    ).toEqual(["packaged"]);
    const targets = matrix.include
      .filter((row) => row.task === "extension-file-shard")
      .flatMap((row) => row.includePatterns);
    expect(targets.toSorted()).toEqual([rootTest, sourceTest].toSorted());
  });

  it("keeps Telegram out of balanced batches and covers every extension exactly once", () => {
    const allShards = createExtensionTestShards({
      cwd: process.cwd(),
      shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
    });
    const allExtensionIds = allShards.flatMap((shard) => shard.extensionIds);
    const genericExtensionIds = allExtensionIds.filter((extensionId) => extensionId !== "telegram");
    const genericShards = createExtensionTestShards({
      cwd: process.cwd(),
      extensionIds: genericExtensionIds,
      shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
    });
    const genericIds = genericShards.flatMap((shard) => shard.extensionIds);
    expect(genericShards).toHaveLength(DEFAULT_EXTENSION_TEST_SHARD_COUNT);
    expect(genericIds.toSorted()).toEqual(genericExtensionIds.toSorted());
    expect(allExtensionIds.filter((extensionId) => extensionId === "telegram")).toEqual([
      "telegram",
    ]);
    expect(
      allShards
        .flatMap((shard) => shard.planGroups)
        .find((group) => group.config === telegramConfig),
    ).toMatchObject({
      config: telegramConfig,
      extensionIds: ["telegram"],
      roots: ["extensions/telegram"],
    });
    expect(new Set(genericIds).size).toBe(genericExtensionIds.length);
  });

  it("keeps dedicated Telegram and Codex file shards inside the existing aggregate job contract", () => {
    const workflow = readWorkflow();
    const extensionJob = workflow.jobs["plugin-prerelease-extension-shard"];
    const runStep = findStep(extensionJob, "Run extension shard");
    const suite = workflow.jobs["plugin-prerelease-suite"];
    const matrix = runPluginPrereleaseManifest();
    const genericRows = matrix.include.filter((row) => row.task === "extensions-batch");
    // Codex alone took 36-60 min as one hosted batch job; it now gets file-bounded jobs.
    const fileRows = (id: string) =>
      matrix.include.filter(
        (row) => row.task === "extension-file-shard" && row.extensions_csv === id,
      );
    const codexRows = fileRows("codex");
    const codexFiles = [
      ...listRunnableExtensionTestFiles(false, "codex"),
      ...listRunnableExtensionTestFiles(true, "codex"),
    ].toSorted();

    expect(genericRows.some((row) => row.extensions_csv.split(",").includes("codex"))).toBe(false);
    expect(codexFiles.length).toBeGreaterThan(100);
    expect(codexRows.flatMap((row) => row.includePatterns).toSorted()).toEqual(codexFiles);
    for (const row of codexRows) {
      expect(row.check_name).toMatch(/^checks-node-extensions-codex-shard-\d+$/u);
      expect(row.includePatterns.length).toBeGreaterThan(0);
      expect(row.includePatterns.length).toBeLessThanOrEqual(24);
      expect(row).toMatchObject({ requires_bun: false, test_runtime_policy: "node" });
    }
    const telegramRows = fileRows("telegram");
    const allFiles = listExtensionTestFilesForRoots(["extensions/telegram"]);
    const telegramFiles = [
      ...listRunnableExtensionTestFiles(),
      ...listRunnableExtensionTestFiles(true),
    ].toSorted();

    expect(genericRows).toHaveLength(DEFAULT_EXTENSION_TEST_SHARD_COUNT);
    expect(genericRows.some((row) => row.extensions_csv.split(",").includes("telegram"))).toBe(
      false,
    );
    const expectedPartitions = [
      [databaseConfig, listRunnableExtensionTestFiles(true)],
      [telegramConfig, listRunnableExtensionTestFiles()],
    ] as const;
    const expectedRows = expectedPartitions.flatMap(([vitest_config, files]) =>
      splitExtensionTestJobTargets(vitest_config, files).map((includePatterns) => ({
        vitest_config,
        includePatterns,
      })),
    );
    expect(telegramRows).toEqual(
      expectedRows.map((row, index) =>
        expect.objectContaining({
          ...row,
          check_name: `checks-node-extensions-telegram-shard-${index + 1}`,
          extensions_csv: "telegram",
          runner: "blacksmith-8vcpu-ubuntu-2404",
        }),
      ),
    );
    const partitions = telegramRows.map((row) => {
      expect(row.includePatterns).toBeInstanceOf(Array);
      return row.includePatterns;
    });
    expect(partitions.every((partition) => partition.length > 0)).toBe(true);
    expect(partitions.flat().toSorted()).toEqual(telegramFiles);
    expect(new Set(partitions.flat()).size).toBe(telegramFiles.length);
    expect(Math.max(...partitions.map((partition) => partition.length))).toBe(10);
    expect(allFiles.filter((file) => !telegramFiles.includes(file)).length).toBeGreaterThan(0);

    const tempDir = fixtures.make("openclaw-plugin-prerelease-telegram-specs-");
    for (const [index, partition] of partitions.entries()) {
      const includeFile = join(tempDir, `telegram-shard-${index + 1}.json`);
      writeFileSync(includeFile, JSON.stringify(partition));
      const specs = createVitestRunSpecs([telegramRows[index]!.vitest_config], {
        baseEnv: {
          OPENCLAW_TEST_PROJECTS_PARALLEL: "2",
          OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
        },
      });

      const includeFiles = specs.map((spec) => spec.env.OPENCLAW_VITEST_INCLUDE_FILE);
      if (telegramRows[index]!.vitest_config === telegramConfig || partition.length === 1) {
        expect(specs.map((spec) => spec.includePatterns)).toEqual([null]);
        expect(includeFiles).toEqual([includeFile]);
        continue;
      }
      expect(specs).toHaveLength(partition.length);
      expect(specs.map((spec) => spec.includePatterns)).toEqual(partition.map((file) => [file]));
      expect(new Set(includeFiles).size).toBe(partition.length);
      expect(includeFiles.every((file) => file !== includeFile)).toBe(true);
    }
    expect(extensionJob.strategy).toMatchObject({
      "fail-fast": false,
      "max-parallel": 12,
      matrix: "${{ fromJson(needs.preflight.outputs.plugin_prerelease_extension_matrix) }}",
    });
    expect(runStep?.env).toMatchObject({
      OPENCLAW_EXTENSION_INCLUDE_PATTERNS_JSON: "${{ toJson(matrix.includePatterns) }}",
      OPENCLAW_EXTENSION_TASK: "${{ matrix.task }}",
      OPENCLAW_EXTENSION_VITEST_CONFIG: "${{ matrix.vitest_config }}",
    });
    expect(runStep?.run).toContain("extension-file-shard)");
    expect(runStep?.run).toContain("OPENCLAW_TEST_PROJECTS_PARALLEL=2");
    expect(runStep?.run).toContain('OPENCLAW_VITEST_INCLUDE_FILE="$include_file"');
    expect(runStep?.run).toContain('pnpm test -- "$OPENCLAW_EXTENSION_VITEST_CONFIG"');
    const shellCheck = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: runStep?.run,
    });
    expect(shellCheck.status, shellCheck.stderr).toBe(0);
    expect(runStep?.run?.match(/extension-file-shard\)([\s\S]*?)\n\s*;;/u)?.[1]).not.toContain(
      "--retry",
    );
    expect(suite.needs).toContain("plugin-prerelease-extension-shard");
    expect(findStep(suite, "Verify plugin prerelease suite").run).toContain(
      'check_required "plugin-prerelease-extensions" "$RUN_EXTENSIONS" "$EXTENSIONS_RESULT"',
    );
  });
});
