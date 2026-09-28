import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectChangedExtensionIds,
  listAvailableExtensionIds,
} from "../../scripts/lib/changed-extensions.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import * as extensionTestPlan from "../../scripts/lib/extension-test-plan.mts";
import { resolveBoundedVitestInvocations } from "../../scripts/run-vitest.mts";
import {
  buildFullSuiteVitestRunPlans,
  buildVitestRunPlans,
} from "../../scripts/test-projects.test-support.mts";
import { withEnv } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { listVitestConfigTestFiles } from "../vitest-projects-config.test-support.js";
import { databaseWorkerExtensionTestFiles } from "../vitest/vitest.extension-database-workers-paths.mjs";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const telegramConfig = "test/vitest/vitest.extension-telegram.config.ts";
const workerConfig = "test/vitest/vitest.extension-database-workers.config.ts";
afterEach(() => vi.restoreAllMocks());

describe("extension executable test plans", () => {
  it("reuses singleton invocation costs across envelopes without pricing multi-file pools as serial", () => {
    const files = ["extensions/telegram/src/one.test.ts", "extensions/telegram/src/two.test.ts"];
    const added = "extensions/telegram/src/three.test.ts";
    const key = extensionTestPlan.createExtensionTestTimingKey;
    const timings: Record<string, number> = {
      [key(workerConfig, [files[0]!], undefined, "singleton-invocation")!]: 10,
      [key(workerConfig, [files[1]!], undefined, "singleton-invocation")!]: 21,
      [key(workerConfig, [], undefined, "wrapper-overhead")!]: 3,
    };
    const samples = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(timings);
    expect(extensionTestPlan.estimateExtensionTestCost(workerConfig, 2, files)).toBe(34);
    expect(extensionTestPlan.estimateExtensionTestCost(workerConfig, 3, [...files, added])).toBe(
      42,
    );
    expect(extensionTestPlan.estimateExtensionTestCost(workerConfig, 2, [files[1]!, added])).toBe(
      32,
    );
    timings[key(workerConfig, files)!] = 60;
    expect(extensionTestPlan.estimateExtensionTestCost(workerConfig, 2, files)).toBe(60);

    samples.mockReturnValue({
      [key(telegramConfig, [files[0]!], undefined, "singleton-invocation")!]: 100,
      [key(telegramConfig, [files[1]!], undefined, "singleton-invocation")!]: 100,
      [key(telegramConfig, [], undefined, "wrapper-overhead")!]: 20,
    });
    expect(extensionTestPlan.estimateExtensionTestCost(telegramConfig, 2, files)).toBe(9);
    samples.mockReturnValue({
      [key(
        workerConfig,
        [files[0]!],
        { OPENCLAW_VITEST_MAX_WORKERS: "8" },
        "singleton-invocation",
      )!]: 100,
      [key(
        workerConfig,
        [files[1]!],
        { OPENCLAW_VITEST_MAX_WORKERS: "2", MODE: "other" },
        "singleton-invocation",
      )!]: 100,
    });
    expect(extensionTestPlan.estimateExtensionTestCost(workerConfig, 2, files)).toBe(16);
    const only = [files[0]!];
    samples.mockReturnValue({ [key(workerConfig, only)!]: 22 });
    expect(extensionTestPlan.estimateExtensionTestCost(workerConfig, 1, only)).toBe(22);
    samples.mockReturnValue({
      [key(workerConfig, only)!]: 22,
      [key(workerConfig, only, undefined, "singleton-invocation")!]: 20,
      [key(workerConfig, [], undefined, "wrapper-overhead")!]: 2,
    });
    expect(extensionTestPlan.estimateExtensionTestCost(workerConfig, 1, only)).toBe(22);
  });

  it.each(["git", "filesystem"])("reads each candidate checkout's %s plugin inventory", (kind) => {
    const root = "extensions/fixture";
    for (const snapshot of ["before", "after"]) {
      const cwd = tempDirs.make(`extension-inventory-${snapshot}-`);
      const selected = `${root}/${snapshot}.test.ts`;
      const files = [
        `${root}/package.json`,
        `${root}/openclaw.plugin.json`,
        `extensions/${snapshot}/package.json`,
        `extensions/manifest-${snapshot}/openclaw.plugin.json`,
        `extensions/nested/${snapshot}/openclaw.plugin.json`,
        selected,
        `${root}/browser/ui.test.ts`,
        `${root}/dist/generated.test.ts`,
        `${root}/node_modules/dependency/copied.test.ts`,
      ];
      for (const file of files) {
        const absolute = path.join(cwd, file);
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, file.endsWith(".json") ? "{}\n" : "export {};\n");
      }
      if (kind === "git") {
        for (const args of [["init"], ["add", "."]]) {
          execFileSync("git", args, { cwd, stdio: "ignore" });
        }
        const untracked = path.join(cwd, "extensions/untracked");
        mkdirSync(untracked);
        writeFileSync(path.join(untracked, "openclaw.plugin.json"), "{}\n");
      }
      expect(listAvailableExtensionIds(cwd)).toEqual(
        [snapshot, "fixture", `manifest-${snapshot}`].toSorted(),
      );
      expect(extensionTestPlan.listExtensionTestFilesForRoots([root], cwd)).toEqual([selected]);
      expect(extensionTestPlan.listExtensionTestFilesForRoots([selected], cwd)).toEqual([selected]);
    }
  });

  it.each([
    { selection: "name", targetArg: "active-memory", cwd: process.cwd() },
    { selection: "path", targetArg: "extensions/active-memory", cwd: process.cwd() },
    { selection: "cwd", cwd: path.join(process.cwd(), "extensions/active-memory") },
  ])("plans manifest-only Active Memory by $selection", ({ targetArg, cwd }) => {
    expect(extensionTestPlan.resolveExtensionTestPlan({ targetArg, cwd })).toMatchObject({
      extensionId: "active-memory",
      extensionDir: "extensions/active-memory",
      hasTests: true,
      planGroups: [
        {
          config: "test/vitest/vitest.extension-active-memory.config.ts",
          roots: ["extensions/active-memory"],
        },
        {
          config: workerConfig,
          roots: ["extensions/active-memory/index.test.ts"],
        },
      ],
    });
  });

  it("includes manifest-only Active Memory in default and changed discovery", () => {
    expect(listAvailableExtensionIds()).toContain("active-memory");
    expect(detectChangedExtensionIds(["extensions/active-memory/index.ts"])).toEqual([
      "active-memory",
    ]);
  });

  it.each([
    { name: "matrix", limit: 40, workerLimit: 40 },
    { name: "codex", limit: 24, workerLimit: 12 },
    { name: "telegram", limit: 10, workerLimit: 1 },
  ])(
    "bounds $name files with their actual ordinary and database owners",
    async ({ name, limit, workerLimit }) => {
      const root = `extensions/${name}`;
      const config = `test/vitest/vitest.extension-${name}.config.ts`;
      const expected = (await listVitestConfigTestFiles(config)).toSorted();
      const chunks = extensionTestPlan.createExtensionTestProcessTargetChunks(config, [root]);
      expect(chunks).toHaveLength(Math.ceil(expected.length / limit));
      expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= limit)).toBe(true);
      expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(
        Math.min(...chunks.map((chunk) => chunk.length)) + 1,
      );
      expect(chunks.flat().toSorted()).toEqual(expected);

      const workerFiles = (await listVitestConfigTestFiles(workerConfig)).filter((file) =>
        file.startsWith(`${root}/`),
      );
      const plans = buildVitestRunPlans([root]);
      const selected = plans.flatMap((plan) => plan.includePatterns ?? []);
      expect(selected.toSorted()).toEqual([...expected, ...workerFiles].toSorted());
      expect(new Set(selected).size).toBe(selected.length);
      for (const plan of plans) {
        expect(plan.includePatterns?.length).toBeLessThanOrEqual(
          plan.config === workerConfig ? workerLimit : limit,
        );
        for (const file of plan.includePatterns ?? []) {
          expect(plan.config).toBe(
            databaseWorkerExtensionTestFiles.includes(file) ? workerConfig : config,
          );
        }
      }
    },
  );

  it.each(["root", "files"] as const)(
    "keeps raw untracked %s discovery while excluding non-default tests before chunking",
    (selection) => {
      const cwd = tempDirs.make("test-plan-eligibility-");
      const root = path.join(cwd, "extensions/fixture");
      const names = [
        "newly-authored.test.ts",
        "api.live.test.ts",
        "media.e2e.test.ts",
        "._copy.test.ts",
        "vendor/copied.test.ts",
      ];
      const files = names.map((name) => {
        const file = path.join(root, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "export {};\n");
        return path.relative(cwd, file).replaceAll("\\", "/");
      });
      const roots = selection === "root" ? [path.relative(cwd, root)] : files;
      expect(extensionTestPlan.listExtensionTestFilesForRoots(roots, cwd).toSorted()).toEqual(
        files.toSorted(),
      );
      for (const config of [telegramConfig, workerConfig]) {
        expect(
          extensionTestPlan.createExtensionTestProcessTargetChunks(config, roots, [], cwd),
        ).toEqual([[files[0]]]);
        expect(extensionTestPlan.splitExtensionTestJobTargets(config, files)).toEqual([[files[0]]]);
        expect(
          extensionTestPlan.createExtensionTestProcessTargetChunks(config, files.slice(1), [], cwd),
        ).toEqual([]);
      }
    },
  );

  it.each([telegramConfig, workerConfig])(
    "does not widen an excluded inherited selection for %s",
    (config) => {
      const includeFile = path.join(tempDirs.make("extension-excluded-selection-"), "include.json");
      writeFileSync(
        includeFile,
        JSON.stringify(["extensions/telegram/src/api-fetch.live.test.ts"]),
      );
      expect(
        buildVitestRunPlans([config], process.cwd(), undefined, {
          env: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
        }),
      ).toEqual([]);
    },
  );

  it("retains an explicitly requested excluded worker file for the native no-test diagnostic", () => {
    const cwd = tempDirs.make("test-plan-explicit-");
    const target = "extensions/memory-core/excluded.live.test.ts";
    const file = path.join(cwd, target);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "throw new Error('Excluded fixture must never execute');\n");
    expect(buildVitestRunPlans([target], cwd)).toEqual([
      { config: workerConfig, forwardedArgs: [], includePatterns: [target], watchMode: false },
    ]);
  });

  it("omits an empty extension owner from full-suite plans without falling back to its config", () => {
    const original = extensionTestPlan.createExtensionTestProcessTargetChunks;
    vi.spyOn(extensionTestPlan, "createExtensionTestProcessTargetChunks").mockImplementation(
      (config, roots, args) => (config === telegramConfig ? [] : original(config, roots, args)),
    );
    const plans = withEnv({ OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: "1" }, () =>
      buildFullSuiteVitestRunPlans([]),
    );
    expect(plans.some((plan) => plan.config === telegramConfig)).toBe(false);
    expect(plans.some((plan) => plan.config === workerConfig)).toBe(true);
  });

  it.each([
    ["live", "extensions/telegram/src/api-fetch.live.test.ts"],
    ["e2e", "extensions/telegram/src/bot.media.warning-topics.e2e.test.ts"],
  ] as const)("preserves explicit %s config selection", async (kind, file) => {
    const config = `test/vitest/vitest.${kind}.config.ts`;
    expect(extensionTestPlan.createExtensionTestProcessTargetChunks(config, [file])).toEqual([
      [file],
    ]);
    const args = ["run", "--config", config, file];
    expect(resolveBoundedVitestInvocations(args)).toEqual([args]);
    expect(await listVitestConfigTestFiles(config)).toContain(file);
  });
});
