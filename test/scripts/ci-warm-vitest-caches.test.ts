import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveShardPlans, runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import { createVitestCacheWarmGroups } from "../../scripts/lib/ci-node-test-plan.mts";
import { BUN_UI_TEST_ENV } from "../../scripts/lib/ci-test-runtime.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock(import("../../scripts/lib/managed-child-process.mts"), async (importOriginal) => ({
  ...(await importOriginal()),
  runManagedCommand: vi.fn(),
}));

vi.mock(import("../../scripts/lib/ci-node-test-plan.mts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createVitestCacheWarmGroups: vi.fn((profile: "full" | "hybrid-hosted" = "full") => {
      const hosted = actual.createVitestCacheWarmGroups("hybrid-hosted");
      // Keep one compatible file beside a Node-only file and a tooling file.
      // The planner suite owns the production inventory; this proves partitioning.
      const tooling = {
        ...hosted[0]!,
        includePatterns: [
          "packages/media-core/src/mime.test.ts",
          "packages/markdown-core/src/render-aware-chunking.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      };
      return profile === "hybrid-hosted"
        ? [tooling, ...hosted.slice(1)]
        : [
            {
              ...tooling,
              configs: ["test/vitest/vitest.unit-fast.config.ts"],
              includePatterns: tooling.includePatterns.slice(0, 2),
            },
            hosted[1]!,
            hosted.find((group) => group.shard_name === "cache-warm:ui-package")!,
          ];
    }),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("protected Vitest cache collection", () => {
  it.each(["linux", "linux-hosted"])(
    "preserves Node and compatible Bun seeds before final UI pruning after a failure (%s)",
    async (platform) => {
      const root = tempDirs.make("openclaw-cache-warm-test-");
      const cacheRoot = join(root, "transforms");
      const compileRoot = join(root, "compile");
      const groups = createVitestCacheWarmGroups(
        platform === "linux-hosted" ? "hybrid-hosted" : "full",
      );
      const ui = groups.find((group) => group.shard_name === "cache-warm:ui-package")!;
      for (const [name, value] of Object.entries({
        CACHE_WARM_PLATFORM: platform,
        NODE_OPTIONS: "--max-old-space-size=8192",
        NODE_COMPILE_CACHE: compileRoot,
        OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: cacheRoot,
        OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER: "1",
        OPENCLAW_NODE_COMPILE_CACHE_WRITER: "1",
        OPENCLAW_VITEST_INCLUDE_FILE: "inherited-selection.json",
        OPENCLAW_VITEST_WORKER_CACHE: "0",
      })) {
        vi.stubEnv(name, value);
      }
      for (const name of [
        "OPENCLAW_NODE_TEST_TARGETS_JSON",
        "OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64",
        "OPENCLAW_NODE_TEST_ENV_JSON",
        "OPENCLAW_VITEST_MAX_WORKERS",
        "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH",
      ]) {
        vi.stubEnv(name, undefined);
      }
      const invocations: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
      const nonUiCollections: Array<{
        configs: string[];
        runtime: string | undefined;
        files: string[];
      }> = [];
      const uiCollections: Array<{
        args: string[];
        env: NodeJS.ProcessEnv;
        files: string[];
      }> = [];
      const recordUi = (args: string[], env: NodeJS.ProcessEnv) => {
        const includeFile = env.OPENCLAW_VITEST_INCLUDE_FILE;
        expect(includeFile).toBeTruthy();
        uiCollections.push({
          args,
          env,
          files: JSON.parse(readFileSync(includeFile!, "utf8")),
        });
      };
      vi.mocked(runManagedCommand).mockImplementation(async (command) => {
        const { args = [], env = {} } = command;
        invocations.push({ args, env });
        expect(command.requireProcessTreeExit).toBe(true);
        if (args.includes("scripts/ci-run-node-test-shard.mts")) {
          expect(env.OPENCLAW_NODE_TEST_PLAN_CONCURRENCY).toBe("1");
          return await runShardPlans(resolveShardPlans(env), {
            env,
            continueOnFailure: env.OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE === "1",
            scratchDir: root,
            runChild: async (childArgs, childEnv) => {
              expect(childArgs).toContain("--testNamePattern=(?!)");
              if (childArgs.includes("ui/vitest.config.ts")) {
                recordUi(childArgs, childEnv);
              } else {
                nonUiCollections.push({
                  configs: childArgs.slice(0, childArgs.indexOf("--")),
                  runtime: childEnv.OPENCLAW_VITEST_RUNTIME,
                  files: JSON.parse(readFileSync(childEnv.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8")),
                });
                expect(childEnv.NODE_OPTIONS).toBe("--max-old-space-size=8192");
                return childEnv.OPENCLAW_VITEST_RUNTIME === "node" && nonUiCollections.length === 1
                  ? 19
                  : 0;
              }
              return 0;
            },
          });
        } else if (args.includes("scripts/run-vitest.mjs")) {
          recordUi(args, env);
        } else {
          expect(args).toContain("--testNamePattern=(?!)");
          expect(env.NODE_OPTIONS).toBe("--max-old-space-size=8192");
        }
        return invocations.length === 1 ? 19 : 0;
      });
      vi.resetModules();
      await import("../../scripts/ci-warm-vitest-caches.mts");

      expect(createVitestCacheWarmGroups).toHaveBeenLastCalledWith(
        platform === "linux-hosted" ? "hybrid-hosted" : "full",
      );
      expect(process.exitCode).toBe(19);
      expect(uiCollections.map(({ env }) => env.OPENCLAW_VITEST_RUNTIME)).toEqual(["bun", "node"]);
      for (const collection of uiCollections) {
        expect(collection.files).toEqual(ui.includePatterns);
        expect(collection.args).toContain("--testNamePattern=(?!)");
        expect(collection.env.OPENCLAW_VITEST_MAX_WORKERS).toBe("1");
        expect(collection.env.NODE_OPTIONS).toBeUndefined();
        expect(collection.env.NODE_COMPILE_CACHE).toBe(compileRoot);
      }
      const [bun, node] = uiCollections;
      expect(bun!.env).toMatchObject(BUN_UI_TEST_ENV);
      expect(bun!.env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT).toBe(
        join(cacheRoot, "vitest-cache-bun-0"),
      );
      expect(node!.env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT).toBe(
        join(cacheRoot, "vitest-cache-0"),
      );
      expect(bun!.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBeUndefined();
      expect(node!.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBeUndefined();
      expect(existsSync(bun!.env.OPENCLAW_VITEST_INCLUDE_FILE!)).toBe(false);
      expect(invocations.at(-1)!.args).toContain("scripts/ci-run-node-test-shard.mts");
      expect(
        invocations.map(({ env }) => [
          env.OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER,
          env.OPENCLAW_NODE_COMPILE_CACHE_WRITER,
        ]),
      ).toEqual([...invocations.slice(0, -1).map(() => ["0", "0"]), ["1", "1"]]);
      expect(nonUiCollections.filter(({ runtime }) => runtime === "bun")).toEqual([
        {
          configs: ["test/vitest/vitest.unit-fast.config.ts"],
          runtime: "bun",
          files: ["packages/media-core/src/mime.test.ts"],
        },
      ]);
      if (platform === "linux") {
        const nonUiGroups = groups.filter((group) => group !== ui);
        expect(JSON.parse(invocations[0]!.env.OPENCLAW_NODE_TEST_GROUPS_JSON!)).toEqual(
          nonUiGroups,
        );
        expect(nonUiCollections.filter(({ runtime }) => runtime === "node")).toEqual(
          nonUiGroups.map((group) => ({
            configs: group.configs,
            runtime: "node",
            files: group.includePatterns,
          })),
        );
      } else {
        expect(invocations.slice(0, 3).map(({ args }) => args[0])).toEqual([
          "test",
          "test:contracts:plugins",
          "test:contracts:channels",
        ]);
        expect(
          invocations.slice(0, 3).map(({ env }) => env.OPENCLAW_TEST_PROJECTS_PARALLEL),
        ).toEqual(["3", "1", "4"]);
        expect(invocations[0]!.args).toEqual([
          "test",
          ...groups[0]!.includePatterns!,
          "--testNamePattern=(?!)",
        ]);
      }
    },
  );
});
