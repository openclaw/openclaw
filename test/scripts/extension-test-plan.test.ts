import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("retains native process costs only for the measured complete ordered selector", () => {
    const files = [
      "extensions/matrix/src/matrix/delivery-plan.test.ts",
      "extensions/matrix/src/matrix/monitor/handler.active-turn-steering.test.ts",
      "extensions/matrix/src/matrix/monitor/handler.binding-route.test.ts",
      "extensions/matrix/src/matrix/monitor/inbound-dedupe.test.ts",
      "extensions/matrix/src/matrix/monitor/index.credentials.test.ts",
      "extensions/matrix/src/matrix/monitor/startup-verification.test.ts",
      "extensions/matrix/src/matrix/sdk.test.ts",
      "extensions/matrix/src/matrix/sdk/idb-persistence.test.ts",
      "extensions/matrix/src/matrix/sdk/recovery-key-store.test.ts",
      "extensions/matrix/src/matrix/send.authority.integration.test.ts",
      "extensions/matrix/src/matrix/send.test.ts",
      "extensions/matrix/src/matrix/thread-bindings.test.ts",
    ];
    // Run 35826932121 measured 436.610 seconds for this complete child process.
    expect(
      extensionTestPlan.estimateExtensionTestCost(workerConfig, files.length, files),
    ).toBeGreaterThanOrEqual(483);
    const unmeasured = extensionTestPlan.estimateExtensionTestCost(workerConfig, files.length);
    expect(
      extensionTestPlan.estimateExtensionTestCost(workerConfig, files.length, files.toReversed()),
    ).toBe(unmeasured);
    expect(
      extensionTestPlan.estimateExtensionTestCost(
        workerConfig,
        files.length,
        files.with(0, "extensions/matrix/src/matrix/new-owner.test.ts"),
      ),
    ).toBe(unmeasured);
    expect(extensionTestPlan.estimateExtensionTestCost(workerConfig, files.length + 1, files)).toBe(
      extensionTestPlan.estimateExtensionTestCost(workerConfig, files.length + 1),
    );
    expect(extensionTestPlan.estimateExtensionTestCost(telegramConfig, files.length, files)).toBe(
      extensionTestPlan.estimateExtensionTestCost(telegramConfig, files.length),
    );
  });

  it.each([
    { name: "msteams", files: 97, nativeSeconds: 145.762 },
    { name: "media", files: 27, nativeSeconds: 124.988 },
    { name: "irc", files: 20, nativeSeconds: 90.347 },
  ])("prices the complete $name process with native headroom", ({ name, files, nativeSeconds }) => {
    expect(
      extensionTestPlan.estimateExtensionTestCost(
        `test/vitest/vitest.extension-${name}.config.ts`,
        files,
      ),
    ).toBeGreaterThanOrEqual(Math.ceil(nativeSeconds * 1.1 + 2));
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
      const root = tempDirs.make("test-plan-eligibility-", path.join(process.cwd(), "extensions"));
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
        return path.relative(process.cwd(), file).replaceAll("\\", "/");
      });
      const roots = selection === "root" ? [path.relative(process.cwd(), root)] : files;
      expect(extensionTestPlan.listExtensionTestFilesForRoots(roots).toSorted()).toEqual(
        files.toSorted(),
      );
      for (const config of [telegramConfig, workerConfig]) {
        expect(extensionTestPlan.createExtensionTestProcessTargetChunks(config, roots)).toEqual([
          [files[0]],
        ]);
        expect(extensionTestPlan.splitExtensionTestJobTargets(config, files)).toEqual([[files[0]]]);
        expect(
          extensionTestPlan.createExtensionTestProcessTargetChunks(config, files.slice(1)),
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
    const root = tempDirs.make(
      "test-plan-explicit-",
      path.join(process.cwd(), "extensions/memory-core"),
    );
    const file = path.join(root, "excluded.live.test.ts");
    writeFileSync(file, "throw new Error('Excluded fixture must never execute');\n");
    const target = path.relative(process.cwd(), file).replaceAll("\\", "/");
    expect(buildVitestRunPlans([target])).toEqual([
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
