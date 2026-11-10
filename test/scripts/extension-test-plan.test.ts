import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectChangedExtensionIds,
  listAvailableExtensionIds,
} from "../../scripts/lib/changed-extensions.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import * as extensionTestPlan from "../../scripts/lib/extension-test-plan.mts";
import {
  createExtensionTestProcessTargetChunks as chunksFor,
  listExtensionTestFilesForRoots as listFiles,
  resolveExtensionTestPlan as resolvePlan,
  splitExtensionTestJobTargets as splitTargets,
} from "../../scripts/lib/extension-test-plan.mts";
import { createGatewayServerTestTargetChunks } from "../../scripts/lib/gateway-server-test-plan.mts";
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
it("keeps Gateway and plugin file bounds balanced at the owner boundary", () => {
  const cwd = tempDirs.make("balanced-test-targets-");
  const gateway = Array.from(
    { length: 17 },
    (_, index) => `src/gateway/server.balance-${String(index).padStart(2, "0")}.test.ts`,
  );
  gateway.forEach((file) => writeFixture(cwd, file));
  expect(createGatewayServerTestTargetChunks(cwd)).toEqual([gateway.slice(0, 9), gateway.slice(9)]);
  const matrix = Array.from(
    { length: 41 },
    (_, index) => `extensions/matrix/src/balance-${String(index).padStart(2, "0")}.test.ts`,
  );
  const config = "test/vitest/vitest.extension-matrix.config.ts";
  expect(
    extensionTestPlan.splitExtensionTestProcessTargets(config, [
      ...matrix.toReversed(),
      matrix[0]!,
    ]),
  ).toEqual([matrix.slice(0, 21), matrix.slice(21)]);
  expect(extensionTestPlan.splitExtensionTestProcessTargets(config, [])).toEqual([]);
  expect(extensionTestPlan.splitExtensionTestProcessTargets("unbounded", [])).toEqual([[]]);
});

const telegramConfig = "test/vitest/vitest.extension-telegram.config.ts";
const workerConfig = "test/vitest/vitest.extension-database-workers.config.ts";
const telegramFile = (name: string) => `extensions/telegram/src/${name}.test.ts`;
function writeFixture(cwd: string, file: string) {
  const absolute = path.join(cwd, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, file.endsWith(".json") ? "{}\n" : "export {};\n");
  return file;
}
afterEach(() => vi.restoreAllMocks());

describe("extension executable test plans", () => {
  it("reuses singleton invocation costs across envelopes without pricing multi-file pools as serial", () => {
    const [one, two, added] = ["one", "two", "three"].map(telegramFile);
    const files = [one!, two!];
    const { createExtensionTestTimingKey: key, estimateExtensionTestCost: cost } =
      extensionTestPlan;
    const singleton = (file: string, value: number, env?: Record<string, string>) => ({
      [key(workerConfig, [file], env, "singleton-invocation")!]: value,
    });
    const timings: Record<string, number> = {
      ...singleton(one!, 10),
      ...singleton(two!, 21),
      [key(workerConfig, [], undefined, "wrapper-overhead")!]: 3,
    };
    const samples = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(timings);
    expect(cost(workerConfig, 2, files)).toBe(34);
    expect(cost(workerConfig, 3, [...files, added!])).toBe(42);
    expect(cost(workerConfig, 2, [two!, added!])).toBe(32);
    timings[key(workerConfig, files)!] = 60;
    expect(cost(workerConfig, 2, files)).toBe(60);
    const parallelEnv = { OPENCLAW_VITEST_MAX_WORKERS: "2", OPENCLAW_TEST_PROJECTS_PARALLEL: "2" };
    const parallelKey = key(workerConfig, files, parallelEnv)!;
    expect(parallelKey).not.toBe(key(workerConfig, files));
    expect(key(workerConfig, files, { ...parallelEnv, OPENCLAW_TEST_PROJECTS_PARALLEL: "1" })).toBe(
      key(workerConfig, files),
    );
    expect(cost(workerConfig, 2, files, parallelEnv)).toBe(60);
    timings[parallelKey] = 25;
    expect(cost(workerConfig, 2, files, parallelEnv)).toBe(25);
    expect(cost(workerConfig, 2, files)).toBe(60);

    samples.mockReturnValue({
      [key(telegramConfig, [files[0]!], undefined, "singleton-invocation")!]: 100,
      [key(telegramConfig, [files[1]!], undefined, "singleton-invocation")!]: 100,
      [key(telegramConfig, [], undefined, "wrapper-overhead")!]: 20,
    });
    expect(cost(telegramConfig, 2, files)).toBe(9);
    samples.mockReturnValue({
      ...singleton(one!, 100, { OPENCLAW_VITEST_MAX_WORKERS: "8" }),
      ...singleton(two!, 100, { OPENCLAW_VITEST_MAX_WORKERS: "2", MODE: "other" }),
    });
    expect(cost(workerConfig, 2, files)).toBe(16);
    const only = [one!];
    samples.mockReturnValue({ [key(workerConfig, only)!]: 22 });
    expect(cost(workerConfig, 1, only)).toBe(22);
  });

  it("requests overlap only for selected Telegram singleton envelopes", async () => {
    const { createChangedExtensionConfigShards } =
      await import("../../scripts/lib/ci-extension-test-shards.mts");
    const files = ["telegram-ingress-spool", "telegram-ingress-drain", "webhook"].map(telegramFile);
    vi.spyOn(extensionTestPlan, "listExtensionTestFilesForRoots").mockReturnValue(files);
    const shards = createChangedExtensionConfigShards(["extensions/telegram"], {
      targets: new Set(files),
    });
    expect(shards).toHaveLength(1);
    expect(shards[0]).toMatchObject({
      configs: [workerConfig],
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2", OPENCLAW_TEST_PROJECTS_PARALLEL: "2" },
      planConcurrency: 1,
      requiresDist: false,
    });
    expect(shards[0]!.includePatterns?.toSorted()).toEqual(files.toSorted());
  });

  it("reads each candidate checkout's filesystem plugin inventory", () => {
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
      files.forEach((file) => writeFixture(cwd, file));
      expect(listAvailableExtensionIds(cwd)).toEqual(
        [snapshot, "fixture", `manifest-${snapshot}`].toSorted(),
      );
      expect(listFiles([root], cwd)).toEqual([selected]);
      expect(listFiles([selected], cwd)).toEqual([selected]);
    }
  });

  it.each([
    { selection: "name", targetArg: "active-memory", cwd: process.cwd() },
    { selection: "path", targetArg: "extensions/active-memory", cwd: process.cwd() },
    { selection: "cwd", cwd: path.join(process.cwd(), "extensions/active-memory") },
  ])("plans manifest-only Active Memory by $selection", ({ targetArg, cwd }) => {
    expect(resolvePlan({ targetArg, cwd })).toMatchObject({
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
      const chunks = chunksFor(config, [root]);
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

  it("keeps raw untracked root discovery while excluding non-default tests before chunking", () => {
    const cwd = tempDirs.make("test-plan-eligibility-");
    const root = "extensions/fixture";
    const names = [
      "newly-authored.test.ts",
      "api.live.test.ts",
      "media.e2e.test.ts",
      "._copy.test.ts",
      "vendor/copied.test.ts",
    ];
    const files = names.map((name) => writeFixture(cwd, `${root}/${name}`));
    const roots = [root];
    expect(listFiles(roots, cwd).toSorted()).toEqual(files.toSorted());
    for (const config of [telegramConfig, workerConfig]) {
      expect(chunksFor(config, roots, [], cwd)).toEqual([[files[0]]]);
      expect(splitTargets(config, files)).toEqual([[files[0]]]);
      expect(chunksFor(config, files.slice(1), [], cwd)).toEqual([]);
    }
  });

  it("keeps Workboard directory and glob selections beside explicit PostgreSQL files", () => {
    const cwd = tempDirs.make("extension-mixed-postgres-");
    const files = [
      "extensions/workboard/src/store.test.ts",
      "extensions/workboard/src/retained-roots.test.ts",
      "extensions/logbook/src/postgres-store.test.ts",
      "extensions/matrix/src/matrix/account-state.postgres.test.ts",
    ];
    files.forEach((file) => writeFixture(cwd, file));
    for (const workboard of ["extensions/workboard", "extensions/workboard/**/*.test.ts"]) {
      const plans = buildVitestRunPlans([workboard, ...files.slice(2)], cwd);
      expect(plans.flatMap((plan) => plan.includePatterns ?? []).toSorted()).toEqual(
        files.toSorted(),
      );
      expect(plans.every((plan) => plan.config === workerConfig)).toBe(true);
    }
  });

  it.each([telegramConfig])("does not widen an excluded inherited selection for %s", (config) => {
    const includeFile = path.join(tempDirs.make("extension-excluded-selection-"), "include.json");
    writeFileSync(includeFile, JSON.stringify(["extensions/telegram/src/api-fetch.live.test.ts"]));
    expect(
      buildVitestRunPlans([config], process.cwd(), undefined, {
        env: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      }),
    ).toEqual([]);
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
    ["e2e", "extensions/telegram/src/bot.media.stickers-and-fragments.e2e.test.ts"],
  ] as const)("preserves explicit %s config selection", async (kind, file) => {
    const config = `test/vitest/vitest.${kind}.config.ts`;
    expect(chunksFor(config, [file])).toEqual([[file]]);
    const args = ["run", "--config", config, file];
    expect(resolveBoundedVitestInvocations(args)).toEqual([args]);
    expect(await listVitestConfigTestFiles(config)).toContain(file);
  });
});
