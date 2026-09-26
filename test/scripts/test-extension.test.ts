// Test Extension tests cover test extension script behavior.
/* oxlint-disable typescript/no-unnecessary-type-parameters -- explicit call-site result types keep mock tuple extraction precise. */
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bundledPluginFile, bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseCLI } from "vitest/node";
import {
  detectChangedExtensionIds,
  listAvailableExtensionIds,
  listChangedExtensionIds,
} from "../../scripts/lib/changed-extensions.mts";
import {
  DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  createExtensionTestProcessTargetChunks,
  createExtensionTestShards,
  estimateExtensionTestCost,
  listExtensionTestFilesForRoots,
  listTrackedTestPlanFiles,
  resolveExtensionBatchPlan,
  resolveExtensionTestConfig,
  resolveExtensionTestPlan,
} from "../../scripts/lib/extension-test-plan.mts";
import { relativizeExtensionVitestArgs } from "../../scripts/lib/extension-vitest-paths.mts";
import type { VitestBatchRunParams } from "../../scripts/lib/vitest-batch-runner.mts";
import {
  prepareVitestRuntime,
  resolveVitestPretestBuildMode,
} from "../../scripts/lib/vitest-build-prerequisites.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import {
  parseExtensionIds,
  parseExactVitestExcludePaths,
  resolveExtensionBatchParallelism,
  runExtensionBatchPlan,
} from "../../scripts/test-extension-batch.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { waitForPidFile } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { listVitestConfigTestFiles } from "../vitest-projects-config.test-support.js";
import { databaseWorkerExtensionTestFiles } from "../vitest/vitest.extension-database-workers-paths.mjs";
import { extensionCatchAllExcludedTestRoots } from "../vitest/vitest.extensions.config.ts";

vi.mock("../../scripts/lib/vitest-build-prerequisites.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/vitest-build-prerequisites.mts")>()),
  prepareVitestRuntime: vi.fn().mockResolvedValue(0),
}));

const scriptPath = path.join(process.cwd(), "scripts", "test-extension.mts");
const posixIt = process.platform === "win32" ? it.skip : it;
const MATRIX_TEST_PROCESS_FILE_LIMIT = 40;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type RunGroupParams = VitestBatchRunParams;

function createConcurrentExtensionBatchPlan() {
  const groups = [
    ["light", 10, "one", 1],
    ["heavy", 30, "two", 3],
    ["middle", 20, "three", 2],
  ] as const;
  return {
    extensionCount: groups.length,
    extensionIds: groups.map((group) => group[2]),
    estimatedCost: 60,
    hasTests: true,
    planGroups: groups.map(([config, estimatedCost, extensionId, testFileCount]) => ({
      config,
      estimatedCost,
      extensionIds: [extensionId],
      roots: [`extensions/${extensionId}`],
      testFileCount,
    })),
    testFileCount: 6,
  };
}

function runScriptResult(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function requireFirstMockArg<T>(mock: { mock: { calls: readonly (readonly unknown[])[] } }): T {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected first mock call argument");
  }
  const [arg] = call;
  if (arg === undefined) {
    throw new Error("expected first mock call argument");
  }
  return arg as T;
}

function findExtensionWithoutTests() {
  const extensionId = listAvailableExtensionIds().find(
    (candidate) => !resolveExtensionTestPlan({ targetArg: candidate, cwd: process.cwd() }).hasTests,
  );

  if (!extensionId) {
    throw new Error("Expected at least one extension without tests");
  }
  return extensionId;
}

function listExtensionTestFiles(extensionId: string): string[] {
  return listExtensionTestFilesForRoots([bundledPluginRoot(extensionId)]);
}

function expectedMatrixTestProcessCount() {
  const files = listExtensionTestFilesForRoots([bundledPluginRoot("matrix")]);
  const workers = files.filter((file) => databaseWorkerExtensionTestFiles.includes(file));
  return (
    Math.ceil(workers.length / MATRIX_TEST_PROCESS_FILE_LIMIT) +
    Math.ceil((files.length - workers.length) / MATRIX_TEST_PROCESS_FILE_LIMIT)
  );
}

function expectPositiveIntegerMetric(value: number) {
  expect(Number.isInteger(value)).toBe(true);
  expect(value).toBeGreaterThan(0);
}

describe("scripts/test-extension.mts", () => {
  let balancedExtensionShards: ReturnType<typeof createExtensionTestShards>;
  let balancedExpectedExtensionIds: string[];

  beforeAll(() => {
    balancedExtensionShards = createExtensionTestShards({
      cwd: process.cwd(),
      shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
    });
    balancedExpectedExtensionIds = listAvailableExtensionIds().filter(
      (extensionId) =>
        resolveExtensionTestPlan({ cwd: process.cwd(), targetArg: extensionId }).hasTests,
    );
  });

  it.each(extensionCatchAllExcludedTestRoots)(
    "routes catch-all-excluded extension root %s to a dedicated config",
    (root) => {
      expect(resolveExtensionTestConfig(root)).not.toBe("test/vitest/vitest.extensions.config.ts");
    },
  );

  it("resolves split channel extensions onto their own vitest configs", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "slack", cwd: process.cwd() });

    expect(plan.extensionId).toBe("slack");
    expect(plan.extensionDir).toBe(bundledPluginRoot("slack"));
    expect(plan.config).toBe("test/vitest/vitest.extension-slack.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("slack"));
    expect(plan.hasTests).toBe(true);
  });

  it.each([
    { extensionId: "acpx" },
    { extensionId: "diffs" },
    { extensionId: "feishu" },
    { extensionId: "matrix" },
    { extensionId: "telegram" },
    { extensionId: "whatsapp" },
    { extensionId: "voice-call" },
    { extensionId: "mattermost" },
    { extensionId: "irc" },
    { extensionId: "zalo" },
    { extensionId: "msteams" },
    { extensionId: "codex" },
  ])("resolves $extensionId onto the $extensionId vitest config", ({ extensionId }) => {
    const plan = resolveExtensionTestPlan({ targetArg: extensionId, cwd: process.cwd() });

    expect(plan.extensionId).toBe(extensionId);
    expect(plan.config).toBe(`test/vitest/vitest.extension-${extensionId}.config.ts`);
    expect(plan.roots).toContain(bundledPluginRoot(extensionId));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves OpenAI onto its own provider vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "openai", cwd: process.cwd() });

    expect(plan.extensionId).toBe("openai");
    expect(plan.config).toBe("test/vitest/vitest.extension-provider-openai.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("openai"));
    expect(plan.hasTests).toBe(true);
  });

  it.each([
    {
      extensionId: "imessage",
      workerFiles: databaseWorkerExtensionTestFiles.filter((file) =>
        file.startsWith("extensions/imessage/"),
      ),
    },
    {
      extensionId: "feishu",
      workerFiles: databaseWorkerExtensionTestFiles.filter((file) =>
        file.startsWith("extensions/feishu/"),
      ),
    },
  ])(
    "splits the $extensionId batch between persistence and channel owners without double counting",
    ({ extensionId, workerFiles }) => {
      const root = `extensions/${extensionId}`;
      const batch = resolveExtensionBatchPlan({ extensionIds: [extensionId] });
      const files = listExtensionTestFilesForRoots([root]);
      expect(batch.extensionIds).toEqual([extensionId]);
      expect(batch.testFileCount).toBe(files.length);
      expect(batch.planGroups).toEqual([
        expect.objectContaining({
          config: "test/vitest/vitest.extension-database-workers.config.ts",
          roots: workerFiles,
          extensionIds: [extensionId],
          testFileCount: workerFiles.length,
        }),
        expect.objectContaining({
          config: `test/vitest/vitest.extension-${extensionId}.config.ts`,
          roots: [root],
          extensionIds: [extensionId],
          testFileCount: files.length - workerFiles.length,
        }),
      ]);
      expect(listExtensionTestFilesForRoots(batch.planGroups[0]!.roots)).toEqual(
        workerFiles.toSorted(),
      );
      const shards = createExtensionTestShards({ extensionIds: [extensionId], shardCount: 2 });
      expect(shards).toHaveLength(1);
      expect(shards[0]?.planGroups).toEqual(batch.planGroups);
    },
  );

  it("excludes plugin browser tests from the server-side extension inventory", () => {
    const files = listExtensionTestFilesForRoots([bundledPluginRoot("workboard")]);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.includes("/browser/"))).toBe(false);
  });

  posixIt("preserves newline and leading-space tokens in the tracked Git inventory", () => {
    const root = tempDirs.make("openclaw-extension-git-paths-");
    const trackedPaths = [" extensions/example.test.ts", "extensions/example\npath.test.ts"];
    expect(spawnSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root }).status).toBe(0);
    for (const trackedPath of trackedPaths) {
      const absolutePath = path.join(root, trackedPath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, "export {};\n");
    }
    expect(spawnSync("git", ["add", "--", ...trackedPaths], { cwd: root }).status).toBe(0);

    expect(listTrackedTestPlanFiles(root, [":(glob)**/*.test.ts"])?.toSorted()).toEqual(
      trackedPaths.toSorted(),
    );
  });

  it.each([
    ["watch", ["--watch"]],
    ["short watch", ["-w"]],
    ["coverage", ["--coverage"]],
    ["reporter", ["--reporter=json"]],
    ["output file", ["--outputFile=results.json"]],
    ["shard", ["--shard=1/2"]],
    ["retry with shard", ["--retry=1", "--shard=1/2"]],
    ["retry with report", ["--retry=1", "--reporter=json"]],
    ["missing retry value", ["--retry"]],
    ["invalid retry value", ["--retry=invalid"]],
    ["missing exclude value", ["--exclude"]],
    ["bail", ["--bail=2"]],
    ["changed", ["--changed=origin/main"]],
    ["exclude", ["--exclude=extensions/matrix/src/**"]],
    ["one-or-more extglob exclude", ["--exclude=extensions/matrix/src/+(a).test.ts"]],
    ["exactly-one extglob exclude", ["--exclude=extensions/matrix/src/@(a).test.ts"]],
  ])("keeps Matrix %s runs in one process", (_name, vitestArgs) => {
    const root = bundledPluginRoot("matrix");

    expect(
      createExtensionTestProcessTargetChunks(
        "test/vitest/vitest.extension-matrix.config.ts",
        [root],
        vitestArgs,
      ),
    ).toEqual([[root]]);
  });

  it.each([
    ["memory-core", "test/vitest/vitest.extension-database-workers.config.ts"],
    ["memory-lancedb", "test/vitest/vitest.extension-memory.config.ts"],
    ["memory-wiki", "test/vitest/vitest.extension-memory.config.ts"],
  ])("resolves %s onto its memory storage owner", (extensionId, config) => {
    const plan = resolveExtensionTestPlan({ targetArg: extensionId, cwd: process.cwd() });

    expect(plan.extensionId).toBe(extensionId);
    expect(plan.config).toBe(config);
    expect(plan.roots).toContain(bundledPluginRoot(extensionId));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves broad dedicated extension groups onto their narrow vitest configs", () => {
    expect(resolveExtensionTestPlan({ targetArg: "browser", cwd: process.cwd() }).config).toBe(
      "test/vitest/vitest.extension-browser.config.ts",
    );
    expect(resolveExtensionTestPlan({ targetArg: "qa-lab", cwd: process.cwd() }).config).toBe(
      "test/vitest/vitest.extension-qa.config.ts",
    );
    expect(resolveExtensionTestPlan({ targetArg: "vydra", cwd: process.cwd() }).config).toBe(
      "test/vitest/vitest.extension-media.config.ts",
    );
    expect(resolveExtensionTestPlan({ targetArg: "firecrawl", cwd: process.cwd() }).config).toBe(
      "test/vitest/vitest.extension-misc.config.ts",
    );
  });

  it("omits src/<extension> when no paired core root exists", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "line", cwd: process.cwd() });

    expect(plan.roots).toContain(bundledPluginRoot("line"));
    expect(plan.roots).not.toContain("src/line");
    expect(plan.config).toBe("test/vitest/vitest.extension-line.config.ts");
    expect(plan.hasTests).toBe(true);
  });

  it("infers the extension from the current working directory", () => {
    const cwd = path.join(process.cwd(), "extensions", "slack");
    const plan = resolveExtensionTestPlan({ cwd });

    expect(plan.extensionId).toBe("slack");
    expect(plan.extensionDir).toBe(bundledPluginRoot("slack"));
  });

  it("maps changed paths back to extension ids", () => {
    const extensionIds = detectChangedExtensionIds([
      bundledPluginFile("slack", "src/channel.ts"),
      "src/line/message.test.ts",
      bundledPluginFile("firecrawl", "package.json"),
      "src/not-a-plugin/file.ts",
    ]);

    expect(extensionIds).toEqual(["firecrawl", "line", "slack"]);
  });

  it("does not normalize extension path lookalikes", () => {
    expect(
      detectChangedExtensionIds([
        " extensions/slack/src/channel.ts",
        String.raw`extensions\slack\src\channel.ts`,
        " src/line/message.test.ts",
      ]),
    ).toEqual([]);
  });

  it("lists available extension ids", () => {
    const extensionIds = listAvailableExtensionIds();

    expect(extensionIds).toContain("slack");
    expect(extensionIds).toContain("firecrawl");
    expect(extensionIds).toEqual(
      [...extensionIds].toSorted((left, right) => left.localeCompare(right)),
    );
  });

  it("lists available extension ids from git without reading extension directories", () => {
    const payload = expectNoNodeFsScans<{
      changed: string[];
      ids: number;
    }>(`
      const { detectChangedExtensionIds, listAvailableExtensionIds } =
        await import("./scripts/lib/changed-extensions.mts");
      const ids = listAvailableExtensionIds();
      const changed = detectChangedExtensionIds([
        "extensions/slack/src/channel.ts",
        "src/line/message.test.ts",
        "extensions/not-real/package.json",
      ]);
      return { changed, ids: ids.length };
    `);
    expect(payload.changed).toEqual(["line", "slack"]);
    expect(payload.ids).toBeGreaterThan(0);
  });

  it("can fail safe to all extensions when the base revision is unavailable", () => {
    const extensionIds = listChangedExtensionIds({
      base: "refs/heads/openclaw-test-missing-base",
      unavailableBaseBehavior: "all",
    });

    expect(extensionIds).toEqual(listAvailableExtensionIds());
  });

  it("resolves a plan for extensions without tests", () => {
    const extensionId = findExtensionWithoutTests();
    const plan = resolveExtensionTestPlan({ cwd: process.cwd(), targetArg: extensionId });

    expect(plan.extensionId).toBe(extensionId);
    expect(plan.hasTests).toBe(false);
    expect(plan.testFileCount).toBe(0);
  });

  it("keeps native hook relay consumers on the broker in changed extension plans", () => {
    const plan = resolveExtensionBatchPlan({ extensionIds: ["codex"] });
    const groups = plan.planGroups.map((group) => ({
      config: group.config,
      files: createExtensionTestProcessTargetChunks(group.config, group.roots).flat(),
    }));
    for (const file of [
      "extensions/codex/src/app-server/run-attempt-one-shot-cleanup.test.ts",
      "extensions/codex/src/app-server/run-attempt.context-engine.test.ts",
    ]) {
      expect(
        groups.filter((group) => group.files.includes(file)).map((group) => group.config),
      ).toEqual(["test/vitest/vitest.extension-database-workers.config.ts"]);
    }
  });

  it("batches extensions into config-specific vitest invocations", () => {
    const batch = resolveExtensionBatchPlan({
      cwd: process.cwd(),
      extensionIds: [
        "slack",
        "firecrawl",
        "line",
        "openai",
        "matrix",
        "telegram",
        "mattermost",
        "voice-call",
        "whatsapp",
        "zalo",
        "zalouser",
        "memory-core",
        "msteams",
        "feishu",
        "irc",
        "acpx",
        "diffs",
        "browser",
        "qa-lab",
        "vydra",
      ],
    });

    expect(batch.extensionIds).toEqual([
      "acpx",
      "browser",
      "diffs",
      "feishu",
      "firecrawl",
      "irc",
      "line",
      "matrix",
      "mattermost",
      "memory-core",
      "msteams",
      "openai",
      "qa-lab",
      "slack",
      "telegram",
      "voice-call",
      "vydra",
      "whatsapp",
      "zalo",
      "zalouser",
    ]);
    const allFiles = listExtensionTestFilesForRoots(batch.extensionIds.map(bundledPluginRoot));
    const groupedFiles = batch.planGroups.flatMap((group) => {
      const files = listExtensionTestFilesForRoots(group.roots).filter(
        (file) =>
          group.config === "test/vitest/vitest.extension-database-workers.config.ts" ||
          !databaseWorkerExtensionTestFiles.includes(file),
      );
      expect(group.testFileCount).toBe(files.length);
      return files;
    });
    expect(batch.testFileCount).toBe(allFiles.length);
    expect(groupedFiles.toSorted()).toEqual(allFiles.toSorted());
    expect(new Set(groupedFiles).size).toBe(allFiles.length);
    const stablePlanGroups = batch.planGroups.map(({ estimatedCost, testFileCount, ...group }) => {
      expectPositiveIntegerMetric(estimatedCost);
      expectPositiveIntegerMetric(testFileCount);
      return group;
    });

    expect(stablePlanGroups).toEqual([
      {
        config: "test/vitest/vitest.extension-acpx.config.ts",
        extensionIds: ["acpx"],
        roots: [bundledPluginRoot("acpx")],
      },
      {
        config: "test/vitest/vitest.extension-browser.config.ts",
        extensionIds: ["browser"],
        roots: [bundledPluginRoot("browser")],
      },
      {
        config: "test/vitest/vitest.extension-database-workers.config.ts",
        extensionIds: [
          "acpx",
          "browser",
          "diffs",
          "feishu",
          "irc",
          "line",
          "matrix",
          "mattermost",
          "memory-core",
          "msteams",
          "qa-lab",
          "telegram",
          "voice-call",
          "whatsapp",
          "zalo",
          "zalouser",
        ],
        roots: [
          ...[
            "line",
            "matrix",
            "telegram",
            "mattermost",
            "voice-call",
            "whatsapp",
            "zalo",
            "zalouser",
          ].flatMap((extensionId) =>
            databaseWorkerExtensionTestFiles.filter((file) =>
              file.startsWith(`extensions/${extensionId}/`),
            ),
          ),
          bundledPluginRoot("memory-core"),
          ...["msteams", "feishu", "irc", "acpx", "diffs", "browser", "qa-lab"].flatMap(
            (extensionId) =>
              databaseWorkerExtensionTestFiles.filter((file) =>
                file.startsWith(`extensions/${extensionId}/`),
              ),
          ),
        ],
      },
      {
        config: "test/vitest/vitest.extension-diffs.config.ts",
        extensionIds: ["diffs"],
        roots: [bundledPluginRoot("diffs")],
      },
      {
        config: "test/vitest/vitest.extension-feishu.config.ts",
        extensionIds: ["feishu"],
        roots: [bundledPluginRoot("feishu")],
      },
      {
        config: "test/vitest/vitest.extension-irc.config.ts",
        extensionIds: ["irc"],
        roots: [bundledPluginRoot("irc")],
      },
      {
        config: "test/vitest/vitest.extension-line.config.ts",
        extensionIds: ["line"],
        roots: [bundledPluginRoot("line")],
      },
      {
        config: "test/vitest/vitest.extension-matrix.config.ts",
        extensionIds: ["matrix"],
        roots: [bundledPluginRoot("matrix")],
      },
      {
        config: "test/vitest/vitest.extension-mattermost.config.ts",
        extensionIds: ["mattermost"],
        roots: [bundledPluginRoot("mattermost")],
      },
      {
        config: "test/vitest/vitest.extension-media.config.ts",
        extensionIds: ["vydra"],
        roots: [bundledPluginRoot("vydra")],
      },
      {
        config: "test/vitest/vitest.extension-misc.config.ts",
        extensionIds: ["firecrawl"],
        roots: [bundledPluginRoot("firecrawl")],
      },
      {
        config: "test/vitest/vitest.extension-msteams.config.ts",
        extensionIds: ["msteams"],
        roots: [bundledPluginRoot("msteams")],
      },
      {
        config: "test/vitest/vitest.extension-provider-openai.config.ts",
        extensionIds: ["openai"],
        roots: [bundledPluginRoot("openai")],
      },
      {
        config: "test/vitest/vitest.extension-qa.config.ts",
        extensionIds: ["qa-lab"],
        roots: [bundledPluginRoot("qa-lab")],
      },
      {
        config: "test/vitest/vitest.extension-slack.config.ts",
        extensionIds: ["slack"],
        roots: [bundledPluginRoot("slack")],
      },
      {
        config: "test/vitest/vitest.extension-telegram.config.ts",
        extensionIds: ["telegram"],
        roots: [bundledPluginRoot("telegram")],
      },
      {
        config: "test/vitest/vitest.extension-voice-call.config.ts",
        extensionIds: ["voice-call"],
        roots: [bundledPluginRoot("voice-call")],
      },
      {
        config: "test/vitest/vitest.extension-whatsapp.config.ts",
        extensionIds: ["whatsapp"],
        roots: [bundledPluginRoot("whatsapp")],
      },
      {
        config: "test/vitest/vitest.extension-zalo.config.ts",
        extensionIds: ["zalo", "zalouser"],
        roots: [bundledPluginRoot("zalo"), bundledPluginRoot("zalouser")],
      },
    ]);
  });

  it("keeps explicitly requested extensions without tests in batch plans", () => {
    const extensionId = findExtensionWithoutTests();
    const testedExtensionId = "firecrawl";
    const testedExtensionFiles = listExtensionTestFiles(testedExtensionId);
    const batch = resolveExtensionBatchPlan({
      cwd: process.cwd(),
      extensionIds: [extensionId, testedExtensionId],
    });

    expect(batch.extensionIds).toEqual(
      [extensionId, testedExtensionId].toSorted((left, right) => left.localeCompare(right)),
    );
    expect(batch.extensionCount).toBe(2);
    expect(batch.noTestExtensionIds).toEqual([extensionId]);
    expect(batch.hasTests).toBe(true);
    expect(batch.testFileCount).toBe(testedExtensionFiles.length);
    expect(batch.planGroups.flatMap((group) => group.extensionIds)).toEqual([testedExtensionId]);
  });

  it("counts tracked extension tests without walking extension directories", () => {
    const payload = expectNoNodeFsScans<{
      batchTests: number;
      shards: number;
      shardTests: number;
    }>(
      `
        const { createExtensionTestShards, resolveExtensionBatchPlan } =
          await import("./scripts/lib/extension-test-plan.mts");
        const extensionIds = ["matrix", "openai", "slack", "telegram"];
        const batch = resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds });
        const shards = createExtensionTestShards({ cwd: process.cwd(), extensionIds, shardCount: 2 });
        return {
          batchTests: batch.testFileCount,
          shards: shards.length,
          shardTests: shards.reduce((total, shard) => total + shard.testFileCount, 0),
        };
      `,
      { counters: ["readdirSync"] },
    );
    expect(payload.batchTests).toBeGreaterThan(0);
    expect(payload.shards).toBe(2);
    expect(payload.shardTests).toBe(payload.batchTests);
  });

  it("balances extension test shards by estimated CI cost", () => {
    for (const [config, singletonSeconds, tenFileSeconds] of [
      ["test/vitest/vitest.extension-slack.config.ts", 2, 12],
      ["test/vitest/vitest.extension-telegram.config.ts", 6, 43],
      ["test/vitest/vitest.extension-database-workers.config.ts", 8, 76],
    ] as const) {
      expect(estimateExtensionTestCost(config, 1), config).toBe(singletonSeconds);
      expect(estimateExtensionTestCost(config, 10), config).toBe(tenFileSeconds);
    }
    const shards = balancedExtensionShards;

    expect(shards).toHaveLength(DEFAULT_EXTENSION_TEST_SHARD_COUNT);
    expect(shards.map((shard) => shard.checkName)).toEqual(
      shards.map((_shard, index) => `checks-node-extensions-shard-${index + 1}`),
    );

    const assigned = shards.flatMap((shard) => shard.extensionIds);
    const uniqueAssigned = [...new Set(assigned)];

    expect(uniqueAssigned.toSorted((left, right) => left.localeCompare(right))).toEqual(
      balancedExpectedExtensionIds.toSorted((left, right) => left.localeCompare(right)),
    );
    expect(assigned).toHaveLength(balancedExpectedExtensionIds.length);

    const totals = shards.map((shard) => shard.estimatedCost);
    const largestPlugin = Math.max(
      ...balancedExpectedExtensionIds.map(
        (targetArg) => resolveExtensionTestPlan({ targetArg }).estimatedCost,
      ),
    );
    const lowerBound = Math.max(
      largestPlugin,
      Math.ceil(totals.reduce((sum, cost) => sum + cost, 0) / shards.length),
    );
    expect(Math.max(...totals)).toBe(lowerBound);

    for (const shard of shards) {
      expect(shard.extensionIds.length).toBeGreaterThan(0);
    }
  });

  it("rejects malformed extension shard counts", () => {
    expect(() =>
      createExtensionTestShards({
        cwd: process.cwd(),
        extensionIds: ["matrix", "openai"],
        shardCount: "2x",
      }),
    ).toThrow("shardCount must be a positive integer");
  });

  it("runs extension batch config groups concurrently when requested", async () => {
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const runGroup = vi.fn((params: RunGroupParams) => {
      started.push(params.config);
      return new Promise<number>((resolve) => {
        resolvers.push(() => resolve(0));
      });
    });
    const runPromise = runExtensionBatchPlan(createConcurrentExtensionBatchPlan(), {
      env: { OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" },
      runGroup: runGroup as NonNullable<
        NonNullable<Parameters<typeof runExtensionBatchPlan>[1]>["runGroup"]
      >,
      vitestArgs: ["--reporter=dot"],
    });

    await vi.waitFor(() => {
      expect(started).toEqual(["heavy", "middle"]);
    });
    resolvers.shift()?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(started).toEqual(["heavy", "middle", "light"]);
    while (resolvers.length > 0) {
      resolvers.shift()?.();
    }
    await expect(runPromise).resolves.toBe(0);
    expect(runGroup).toHaveBeenCalledTimes(3);
    const firstRunGroupParams = requireFirstMockArg<RunGroupParams>(runGroup);
    expect(firstRunGroupParams).toMatchObject({
      args: ["--reporter=dot"],
      config: "heavy",
      env: {
        OPENCLAW_EXTENSION_BATCH_PARALLEL: "2",
      },
      targets: ["two"],
    });
    const cachePaths = runGroup.mock.calls.map(([params]) =>
      params.env?.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH?.replaceAll("\\", "/"),
    );
    expect(new Set(cachePaths).size).toBe(3);
    expect(
      cachePaths.every((cachePath) =>
        /\/\.cache\/vitest\/slots\/[a-f\d]+\/0$/u.test(cachePath ?? ""),
      ),
    ).toBe(true);
  });

  it("stops admitting extension batch groups after a parallel failure", async () => {
    const started: string[] = [];
    let resolveHeavy: ((code: number) => void) | undefined;
    let resolveMiddle: ((code: number) => void) | undefined;
    const runGroup = vi.fn((params: RunGroupParams) => {
      started.push(params.config);
      return new Promise<number>((resolve) => {
        if (params.config === "heavy") {
          resolveHeavy = resolve;
        } else if (params.config === "middle") {
          resolveMiddle = resolve;
        }
      });
    });
    const runPromise = runExtensionBatchPlan(createConcurrentExtensionBatchPlan(), {
      env: { OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" },
      runGroup: runGroup as NonNullable<
        NonNullable<Parameters<typeof runExtensionBatchPlan>[1]>["runGroup"]
      >,
    });

    await vi.waitFor(() => {
      expect(started).toEqual(["heavy", "middle"]);
    });
    resolveHeavy?.(7);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(started).toEqual(["heavy", "middle"]);
    resolveMiddle?.(0);
    await expect(runPromise).resolves.toBe(7);
    expect(runGroup).toHaveBeenCalledTimes(2);
  });

  it("keeps extension batch parallelism bounded by group count", () => {
    expect(resolveExtensionBatchParallelism(3, { OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" })).toBe(2);
    expect(resolveExtensionBatchParallelism(1, { OPENCLAW_EXTENSION_BATCH_PARALLEL: "4" })).toBe(1);
    expect(resolveExtensionBatchParallelism(3, {})).toBe(1);
  });

  it("rejects malformed extension batch parallelism", () => {
    for (const value of ["nope", "2x", "0"]) {
      expect(() =>
        resolveExtensionBatchParallelism(3, { OPENCLAW_EXTENSION_BATCH_PARALLEL: value }),
      ).toThrow("OPENCLAW_EXTENSION_BATCH_PARALLEL must be a positive integer");
    }
  });

  it("preserves positional Vitest args after the extension batch separator", () => {
    expect(
      parseExtensionIds([
        "telegram",
        "--coverage",
        "--",
        "extensions/telegram/src/index.test.ts",
        "--run",
      ]),
    ).toEqual({
      extensionIds: ["telegram"],
      passthroughArgs: ["--coverage", "extensions/telegram/src/index.test.ts", "--run"],
    });
  });

  it.each([
    { enableMaglev: false, realHomeReplay: false, pool: "forks" },
    { enableMaglev: true, realHomeReplay: false, pool: "forks" },
    { enableMaglev: false, realHomeReplay: true, pool: "forks" },
    { enableMaglev: false, realHomeReplay: false, pool: "threads" },
  ])(
    "runs installed Vitest without pnpm (pool: $pool, Maglev: $enableMaglev, owner-authorized real home: $realHomeReplay)",
    ({ enableMaglev, realHomeReplay, pool }) => {
      const root = realpathSync(
        mkdtempSync(path.join(tmpdir(), "openclaw-test-extension-native-")),
      );
      const home = path.join(root, "home");
      const report = path.join(root, "report.json");
      const config = path.join(root, "vitest.config.mjs");
      const entry = path.join(root, "batch.mts");
      mkdirSync(home);
      symlinkSync(
        path.join(process.cwd(), "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      writeFileSync(
        config,
        `import assert from 'node:assert/strict';
assert.equal(process.execArgv.includes('--no-maglev'), ${!enableMaglev}, 'batch Node defaults');
assert.equal(process.execArgv.includes('--no-concurrent-sparkplug'), true, 'batch Sparkplug policy');
export default {root:${JSON.stringify(root)},cacheDir:${JSON.stringify(path.join(root, "cache"))},test:{include:['*.test.mjs'],pool:${JSON.stringify(pool)},execArgv:['--no-warnings'],globalSetup:[${JSON.stringify(path.join(process.cwd(), "test/vitest/vitest.node-policy.global-setup.ts"))}],maxWorkers:1,fileParallelism:false,cache:false,fsModuleCache:false}};`,
      );
      const expectedHome = realHomeReplay ? JSON.stringify(home) : "path.join(tmpdir(), 'home')";
      writeFileSync(
        path.join(root, "selected.test.mjs"),
        `import {homedir,tmpdir} from 'node:os';import path from 'node:path';import {test,expect} from 'vitest';let attempts=0;test('selected native case',()=>{expect(++attempts).toBe(2);expect(process.execArgv.includes('--no-concurrent-sparkplug')).toBe(${pool === "forks"});expect(process.execArgv).toContain('--no-warnings');expect(process.env.NODE_OPTIONS).toBe('--trace-warnings');expect(process.env.HOME).toBe(${expectedHome});expect(homedir()).toBe(${expectedHome});});`,
      );
      for (const name of ["excluded", "unrelated"]) {
        writeFileSync(
          path.join(root, `${name}.test.mjs`),
          "import {test,expect} from 'vitest';test('must not execute',()=>expect.fail('selection lost'));",
        );
      }
      const params = {
        config,
        homeMode: realHomeReplay ? "live-aware" : undefined,
        args: [
          "--configLoader=native",
          "--retry=1",
          "--reporter=verbose",
          "--reporter=json",
          `--outputFile=${report}`,
          "--exclude",
          "**/excluded.test.mjs",
        ],
        targets: [path.join(root, "selected.test.mjs"), path.join(root, "excluded.test.mjs")],
      } satisfies VitestBatchRunParams;
      writeFileSync(
        entry,
        `import {runVitestBatch} from ${JSON.stringify(path.join(process.cwd(), "scripts/lib/vitest-batch-runner.mts"))};process.exitCode=await runVitestBatch({...${JSON.stringify(params)},env:{...process.env,OPENCLAW_VITEST_ENABLE_MAGLEV:${JSON.stringify(enableMaglev ? "1" : "")}}});`,
      );
      try {
        const result = spawnSync(
          process.execPath,
          ["--import", path.join(process.cwd(), "scripts/tsx.mjs"), entry],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              PATH: "",
              HOME: home,
              USERPROFILE: home,
              OPENCLAW_LIVE_TEST: realHomeReplay ? "1" : "0",
              OPENCLAW_LIVE_USE_REAL_HOME: realHomeReplay ? "1" : "0",
              TMPDIR: root,
              TMP: root,
              TEMP: root,
              SystemRoot: process.env.SystemRoot,
              COREPACK_ENABLE_NETWORK: "0",
              NODE_DISABLE_COMPILE_CACHE: "1",
              NODE_OPTIONS: "--trace-warnings",
              CI: "1",
            },
          },
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.signal).toBeNull();
        const native = JSON.parse(readFileSync(report, "utf8"));
        expect(native.success).toBe(true);
        expect(
          native.testResults.flatMap(
            (file: { assertionResults: { title: string; status: string }[] }) =>
              file.assertionResults.map(({ title, status }) => [title, status]),
          ),
        ).toEqual([["selected native case", "passed"]]);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("relativizes extension Vitest path args to the scoped extensions dir", () => {
    expect(
      relativizeExtensionVitestArgs([
        "--exclude",
        "extensions/codex/src/app-server/run-attempt.test.ts",
        "--outputFile",
        "extensions/codex/report.json",
        "-c",
        "./vitest.local.ts",
        "-r",
        ".",
        "--exclude=extensions/codex/src/app-server/client.test.ts",
        "--exclude=",
        "extensions/codex/src/app-server/stream.test.ts",
        "extensions/codex/src/app-server/models.test.ts",
        "--reporter=dot",
      ]),
    ).toEqual([
      "--exclude",
      "codex/src/app-server/run-attempt.test.ts",
      "--outputFile",
      "extensions/codex/report.json",
      "-c",
      "./vitest.local.ts",
      "-r",
      ".",
      "--exclude=codex/src/app-server/client.test.ts",
      "--exclude=",
      "codex/src/app-server/stream.test.ts",
      "codex/src/app-server/models.test.ts",
      "--reporter=dot",
    ]);
  });

  it.each([
    ["--tagsFilter", "slow"],
    ["--tagsFilter=", "slow"],
    ["--fsModuleCachePath", "extensions/cache"],
    ["--attachmentsDir", "extensions/artifacts"],
    ["--max-workers", "2"],
    ["--watch", "false"],
    ["--no-file-parallelism"],
    ["--retry.delay", "100"],
  ])("preserves native Vitest option operands from a plugin cwd: %j", (...flags) => {
    const target = "extensions/browser/src/example.test.ts";
    const args = relativizeExtensionVitestArgs(
      [...flags, target],
      path.join(process.cwd(), "extensions/browser"),
    );
    expect(parseCLI(["vitest", "run", ...args])).toEqual(
      parseCLI(["vitest", "run", ...flags, "browser/src/example.test.ts"]),
    );
  });

  it("preserves native separator tails without interpreting them as plugin paths", () => {
    const tail = ["--", "extensions/browser/src/literal.test.ts", "--exclude="];
    const args = relativizeExtensionVitestArgs(
      tail,
      path.join(process.cwd(), "extensions/browser"),
    );
    expect(parseCLI(["vitest", "run", ...args])).toEqual(parseCLI(["vitest", "run", ...tail]));
  });

  it.each(["--exclude", "--exclude="])(
    "relativizes absolute %s paths from extension cwd",
    (flag) => {
      const extensionCwd = path.join(process.cwd(), "extensions", "codex");
      expect(
        relativizeExtensionVitestArgs(
          [
            flag,
            path.join(extensionCwd, "src", "app-server", "run-attempt.test.ts"),
            path.join(extensionCwd, "src", "app-server", "client.test.ts"),
          ],
          extensionCwd,
        ),
      ).toEqual([
        flag,
        "codex/src/app-server/run-attempt.test.ts",
        "codex/src/app-server/client.test.ts",
      ]);
    },
  );

  posixIt(
    "preserves wrapper termination when native Vitest exits cleanly after SIGTERM",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-test-extension-signal-"));
      const config = path.join(root, "vitest.config.mjs");
      const entry = path.join(root, "batch.mts");
      const childPidPath = path.join(root, "child.pid");
      const descendantPidPath = path.join(root, "descendant.pid");
      const signaledPath = path.join(root, "signaled");

      writeFileSync(
        config,
        `import {spawn} from 'node:child_process';import fs from 'node:fs';
process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(signaledPath)},'SIGTERM');process.exit(0)});
const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready');"],{stdio:['ignore','pipe','ignore']});
await new Promise(resolve=>descendant.stdout.once('data',resolve));
fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(descendant.pid));
fs.writeFileSync(${JSON.stringify(childPidPath)},String(process.pid));
await new Promise(()=>{});export default {};`,
      );
      const batchRunnerUrl = resolveRuntimeWorkerUrl(scriptModuleEntrypoints.vitestBatchRunner);
      writeFileSync(
        entry,
        `import {runVitestBatch} from ${JSON.stringify(batchRunnerUrl.href)};process.exitCode=await runVitestBatch({config:${JSON.stringify(config)},args:['--configLoader=native'],targets:[]});`,
      );
      const runner = spawn(
        process.execPath,
        [...resolveRuntimeWorkerArgv(batchRunnerUrl).slice(0, -1), entry],
        { cwd: process.cwd(), stdio: "ignore" },
      );
      let childPid = 0;
      let descendantPid = 0;

      try {
        childPid = await waitForPidFile(childPidPath, 5_000);
        descendantPid = await waitForPidFile(descendantPidPath, 5_000);
        expect(Number.isInteger(childPid)).toBe(true);
        expect(Number.isInteger(descendantPid)).toBe(true);

        expect(runner.pid).toBeGreaterThan(0);
        process.kill(runner.pid!, "SIGTERM");
        const result = await waitForClose(runner);

        expect(result).toEqual({ code: null, signal: "SIGTERM" });
        await waitFor(() => fileExists(signaledPath), 5_000);
        expect(readFileSync(signaledPath, "utf8")).toBe("SIGTERM");
        await waitFor(() => !isProcessAlive(childPid), 5_000);
        await waitFor(() => !isProcessAlive(descendantPid), 5_000);
      } finally {
        if (runner.pid && isProcessAlive(runner.pid)) {
          process.kill(runner.pid, "SIGKILL");
        }
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("expands extension batch roots before applying exact Vitest excludes", async () => {
    const runGroup = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    await runExtensionBatchPlan(
      {
        extensionCount: 1,
        extensionIds: ["codex"],
        estimatedCost: 1,
        hasTests: true,
        planGroups: [
          {
            config: "test/vitest/vitest.extensions.config.ts",
            estimatedCost: 1,
            extensionIds: ["codex"],
            roots: [bundledPluginRoot("codex")],
            testFileCount: 1,
          },
        ],
        testFileCount: 1,
      },
      {
        runGroup,
        vitestArgs: ["--exclude", "extensions/codex/src/app-server/run-attempt.test.ts"],
      },
    );

    const runParams = requireFirstMockArg<RunGroupParams>(runGroup);
    expect(runParams.targets).not.toContain("extensions/codex/src/app-server/run-attempt.test.ts");
    expect(runParams.targets).not.toContain("codex/src/app-server/run-attempt.test.ts");
    expect(runParams.targets).toContain("codex/src/app-server/client.test.ts");
  });

  it.each([
    ["--retry=1", "--exclude", "extensions/codex/src/app-server/run-attempt.test.ts"],
    ["--retry", "1", "--exclude=extensions/codex/src/app-server/run-attempt.test.ts"],
  ])("preserves Codex process bounds with release options %j", async (...vitestArgs) => {
    const runGroup = vi.fn<(params: RunGroupParams) => Promise<number>>().mockResolvedValue(0);
    const excluded = "extensions/codex/src/app-server/run-attempt.test.ts";
    const expectedFiles = [
      ...(await listVitestConfigTestFiles("test/vitest/vitest.extension-codex.config.ts")),
      ...(
        await listVitestConfigTestFiles("test/vitest/vitest.extension-database-workers.config.ts")
      ).filter((file) => file.startsWith("extensions/codex/")),
    ]
      .filter((file) => file !== excluded)
      .map((file) => file.replace(/^extensions\//u, ""));

    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["codex"] }),
      { runGroup, vitestArgs },
    );

    expect(result).toBe(0);
    const calls = runGroup.mock.calls.map(([params]) => params);
    const workerCount = expectedFiles.filter((file) =>
      databaseWorkerExtensionTestFiles.includes(`extensions/${file}`),
    ).length;
    expect(calls).toHaveLength(
      Math.ceil(workerCount / 12) + Math.ceil((expectedFiles.length - workerCount) / 24),
    );
    expect(calls.every((call) => call.targets.length <= 24)).toBe(true);
    expect(
      calls
        .filter((call) => call.config === "test/vitest/vitest.extension-database-workers.config.ts")
        .every((call) => call.targets.length <= 12),
    ).toBe(true);
    expect(calls.flatMap((call) => call.targets).toSorted()).toEqual(expectedFiles.toSorted());
    expect(new Set(calls.flatMap((call) => call.targets)).size).toBe(expectedFiles.length);
    for (const call of calls) {
      expect(parseCLI(["vitest", "run", ...call.args]).options).toMatchObject({
        retry: 1,
        exclude: ["codex/src/app-server/run-attempt.test.ts"],
      });
    }
  });

  it("runs Matrix extension batches in bounded sequential processes", async () => {
    const runGroup = vi.fn<(params: RunGroupParams) => Promise<number>>().mockResolvedValue(0);
    const expectedFiles = listExtensionTestFilesForRoots([bundledPluginRoot("matrix")]).map(
      (file) => file.replace(/^extensions\//u, ""),
    );

    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["matrix"] }),
      { runGroup },
    );

    expect(result).toBe(0);
    expect(runGroup).toHaveBeenCalledTimes(expectedMatrixTestProcessCount());
    const calls = runGroup.mock.calls.map(([params]) => params as RunGroupParams);
    expect(calls.every((call) => call.targets.length <= MATRIX_TEST_PROCESS_FILE_LIMIT)).toBe(true);
    expect(calls.flatMap((call) => call.targets).toSorted()).toEqual(expectedFiles.toSorted());
    expect(new Set(calls.flatMap((call) => call.targets)).size).toBe(expectedFiles.length);
  });

  it("runs every Matrix process chunk after an earlier chunk fails", async () => {
    const runGroup = vi
      .fn<(params: RunGroupParams) => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);

    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["matrix"] }),
      { runGroup },
    );

    expect(result).toBe(1);
    expect(runGroup).toHaveBeenCalledTimes(expectedMatrixTestProcessCount());
  });

  it.each([
    ["--watch"],
    ["--coverage"],
    ["--reporter=json"],
    ["--outputFile=results.json"],
    ["--bail=2"],
    ["--changed=origin/main"],
    ["--exclude=extensions/matrix/src/**"],
  ])("keeps Matrix extension batch mode %s in one process", async (vitestArg) => {
    const runGroup = vi.fn<() => Promise<number>>().mockResolvedValue(0);

    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["matrix"] }),
      { runGroup, vitestArgs: [vitestArg] },
    );

    expect(result).toBe(0);
    expect(runGroup).toHaveBeenCalledOnce();
    const invocation = requireFirstMockArg<RunGroupParams>(runGroup);
    expect(invocation.targets).toEqual(["matrix"]);
    expect(invocation.config).toBe("test/vitest/vitest.database-worker-watch.config.ts");
    expect(invocation.homeMode).toBe("live-aware");
    expect(invocation.env?.OPENCLAW_VITEST_DATABASE_WORKER_WATCH_OWNER).toBe(
      "test/vitest/vitest.extension-matrix.config.ts",
    );
    expect(JSON.parse(invocation.env!.OPENCLAW_VITEST_DATABASE_WORKER_WATCH_TESTS!)).toEqual(
      databaseWorkerExtensionTestFiles.filter((file) => file.startsWith("extensions/matrix/")),
    );
  });

  it.each([
    {
      include: "extensions/telegram/src/sticker-cache.selection.test.ts",
      exclude: false,
      mode: "runtime",
    },
    {
      include: "extensions/telegram/src/sticker-cache.selection.test.ts",
      exclude: true,
      mode: undefined,
    },
    {
      include: "extensions/telegram/src/update-offset-store.test.ts",
      exclude: false,
      mode: undefined,
    },
  ])(
    "prepares the selected Telegram leaves before the aggregate ($include, exclude=$exclude)",
    async ({ include, exclude, mode }) => {
      const includeFile = path.join(tempDirs.make("openclaw-extension-selection-"), "include.json");
      writeFileSync(includeFile, JSON.stringify([include]));
      vi.mocked(prepareVitestRuntime).mockClear();
      const runGroup = vi.fn<(params: RunGroupParams) => Promise<number>>().mockResolvedValue(0);
      const env = { OPENCLAW_VITEST_INCLUDE_FILE: includeFile };
      const args = ["--watch", ...(exclude ? ["--exclude", include] : [])];
      const result = await runExtensionBatchPlan(
        resolveExtensionBatchPlan({ extensionIds: ["telegram"] }),
        { env, runGroup, vitestArgs: args },
      );
      expect(result).toBe(0);
      expect(runGroup).toHaveBeenCalledOnce();
      expect(prepareVitestRuntime).toHaveBeenCalledOnce();
      const [selections] = vi.mocked(prepareVitestRuntime).mock.calls[0]!;
      expect(resolveVitestPretestBuildMode(selections)).toBe(mode);
      const invocation = requireFirstMockArg<RunGroupParams>(runGroup);
      expect(invocation.env?.OPENCLAW_VITEST_INCLUDE_FILE).toBe(includeFile);
      expect(invocation.homeMode).toBe("live-aware");
      expect(invocation.args).toEqual(relativizeExtensionVitestArgs(args));
      if (exclude) {
        expect(invocation.targets).not.toContain("telegram/src/sticker-cache.selection.test.ts");
      }
    },
  );

  it("keeps split Matrix exact-exclude targets with their worker or ordinary owner", async () => {
    const excluded = databaseWorkerExtensionTestFiles.find((file) =>
      file.startsWith("extensions/matrix/"),
    )!;
    const runGroup = vi.fn<(params: RunGroupParams) => Promise<number>>().mockResolvedValue(0);
    await runExtensionBatchPlan(resolveExtensionBatchPlan({ extensionIds: ["matrix"] }), {
      runGroup,
      vitestArgs: ["--exclude", excluded],
    });
    const calls = runGroup.mock.calls.map(([invocation]) => invocation);
    const actualFiles = calls.flatMap(({ config, targets }) =>
      targets.map((target) => {
        const file = `extensions/${target}`;
        expect(file).not.toBe(excluded);
        expect(databaseWorkerExtensionTestFiles.includes(file)).toBe(
          config === "test/vitest/vitest.extension-database-workers.config.ts",
        );
        return file;
      }),
    );
    expect(actualFiles.toSorted()).toEqual(
      listExtensionTestFiles("matrix").filter((file) => file !== excluded),
    );
    expect(new Set(actualFiles).size).toBe(actualFiles.length);
  });

  it("fails extension batch groups when exact excludes remove every test", async () => {
    const runGroup = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    const firecrawlTestFiles = listExtensionTestFiles("firecrawl");
    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["firecrawl"] }),
      {
        runGroup,
        vitestArgs: firecrawlTestFiles.flatMap((testFile) => ["--exclude", testFile]),
      },
    );

    expect(result).toBe(1);
    expect(runGroup).not.toHaveBeenCalled();
  });

  it("fails extension batch groups when dir-relative exact excludes remove every test", async () => {
    const runGroup = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    const firecrawlTestFiles = listExtensionTestFiles("firecrawl");
    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["firecrawl"] }),
      {
        runGroup,
        vitestArgs: firecrawlTestFiles.flatMap((testFile) => [
          "--exclude",
          testFile.replace(/^extensions\//u, ""),
        ]),
      },
    );

    expect(result).toBe(1);
    expect(runGroup).not.toHaveBeenCalled();
  });

  it("allows extension batch groups to opt into empty exact excludes", async () => {
    const runGroup = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    const firecrawlTestFiles = listExtensionTestFiles("firecrawl");
    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["firecrawl"] }),
      {
        allowEmptyAfterExclude: true,
        runGroup,
        vitestArgs: firecrawlTestFiles.flatMap((testFile) => ["--exclude", testFile]),
      },
    );

    expect(result).toBe(0);
    expect(runGroup).not.toHaveBeenCalled();
  });

  it("detects exact Vitest excludes in extension batch args", () => {
    expect([
      ...parseExactVitestExcludePaths([
        "--exclude",
        "extensions/codex/src/app-server/run-attempt.test.ts",
      ]),
    ]).toEqual(["extensions/codex/src/app-server/run-attempt.test.ts"]);
    expect([...parseExactVitestExcludePaths(["--exclude=extensions/**/*.test.ts"])]).toEqual([]);
  });

  it("accepts pnpm's leading argument separator before extension ids", () => {
    expect(parseExtensionIds(["--", "telegram,slack", "--run"])).toEqual({
      extensionIds: ["telegram", "slack"],
      passthroughArgs: ["--run"],
    });
  });

  it("fails explicitly requested extensions without tests by default", () => {
    const extensionId = findExtensionWithoutTests();
    const result = runScriptResult([extensionId]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`No tests found for ${bundledPluginRoot(extensionId)}.`);
  });

  it("allows explicitly requested extensions without tests when requested", () => {
    const extensionId = findExtensionWithoutTests();
    const result = runScriptResult([extensionId, "--allow-no-tests"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`No tests found for ${bundledPluginRoot(extensionId)}.`);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(5);
  }
}

async function waitForClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs, undefined, { ref: false }).then(() => {
      throw new Error("timed out waiting for child close");
    }),
  ]);
}

function fileExists(filePath: string): boolean {
  try {
    readFileSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
