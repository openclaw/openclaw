import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
      // Keep representative unit-fast and tooling files in the bounded seed.
      // The planner suite owns the production inventory; this proves runtime coverage.
      const tooling = {
        ...hosted[0]!,
        configs: ["test/vitest/vitest.unit-fast.config.ts", "test/vitest/vitest.tooling.config.ts"],
        includePatterns: [
          "packages/media-core/src/mime.test.ts",
          "test/scripts/update-restart-module-outcome.test.ts",
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
            {
              configs: ["test/vitest/vitest.gateway-methods.config.ts"],
              includePatterns: ["test/plugins/team-reports-http.gateway.test.ts"],
              shard_name: "cache-warm:gateway-methods",
            },
            hosted.find((group) => group.shard_name === "cache-warm:ui-package")!,
          ];
    }),
  };
});

type Invocation = { args: string[]; env: NodeJS.ProcessEnv };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each(["linux", "linux-hosted"])(
  "preserves protected Node and Bun seeds for %s despite the consumer policy",
  async (platform) => {
    const root = tempDirs.make("openclaw-cache-warm-test-");
    const cacheRoot = join(root, "transforms");
    const compileRoot = join(root, "compile");
    const groups = createVitestCacheWarmGroups(
      platform === "linux-hosted" ? "hybrid-hosted" : "full",
    );
    const ui = groups.find((group) => group.shard_name === "cache-warm:ui-package")!;
    for (const [name, value] of Object.entries({
      CI: "true",
      GITHUB_ACTIONS: undefined,
      OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE: undefined,
      CACHE_WARM_PLATFORM: platform,
      OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-all",
      NODE_OPTIONS: "--max-old-space-size=8192",
      NODE_COMPILE_CACHE: compileRoot,
      OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: cacheRoot,
      OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER: "1",
      OPENCLAW_NODE_COMPILE_CACHE_WRITER: "1",
      OPENCLAW_VITEST_INCLUDE_FILE: "inherited-selection.json",
      OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: "inherited-post-shard-selection.json",
      OPENCLAW_VITEST_WORKER_CACHE: "0",
      OPENCLAW_BUN_PATH: undefined,
      OPENCLAW_NODE_TEST_TARGETS_JSON: undefined,
      OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: undefined,
      OPENCLAW_NODE_TEST_ENV_JSON: undefined,
      OPENCLAW_VITEST_MAX_WORKERS: undefined,
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: undefined,
    })) {
      vi.stubEnv(name, value);
    }
    const invocations: Invocation[] = [];
    let uiFiles: string[] = [];
    vi.mocked(runManagedCommand).mockImplementation(async (command) => {
      const { args = [], env = {} } = command;
      invocations.push({ args, env });
      expect(command.requireProcessTreeExit).toBe(true);
      if (args.includes("scripts/ci-run-node-test-shard.mts")) {
        expect(env.OPENCLAW_NODE_TEST_PLAN_CONCURRENCY).toBe("1");
        expect(JSON.parse(env.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON!)).toEqual([
          "--testNamePattern=(?!)",
        ]);
      } else if (args.includes("scripts/run-vitest.mjs")) {
        uiFiles = JSON.parse(readFileSync(env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE!, "utf8"));
      } else {
        expect({ args, options: env.NODE_OPTIONS }).toMatchObject({
          args: expect.arrayContaining(["--testNamePattern=(?!)"]),
          options: "--max-old-space-size=8192",
        });
      }
      return invocations.length === 1 ? 1 : 0;
    });
    vi.resetModules();
    await import("../../scripts/ci-warm-vitest-caches.mts");

    expect(process.exitCode).toBe(1);
    const bun = invocations.find(({ args }) => args.includes("scripts/run-vitest.mjs"))!;
    const node = invocations.at(-1)!;
    expect(uiFiles).toEqual(ui.includePatterns);
    expect(bun.args).toContain("--testNamePattern=(?!)");
    expect(bun.env.OPENCLAW_VITEST_MAX_WORKERS).toBe("1");
    for (const { env } of [bun, node]) {
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.NODE_COMPILE_CACHE).toBe(compileRoot);
      expect(env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBeUndefined();
    }
    expect(bun!.env).toMatchObject({
      ...BUN_UI_TEST_ENV,
      OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: join(cacheRoot, "vitest-cache-bun-0"),
    });
    expect(bun!.env.OPENCLAW_BUN_PATH).toBeUndefined();
    expect(bun!.env.OPENCLAW_VITEST_INCLUDE_FILE).toBeUndefined();
    expect(node.env.OPENCLAW_CI_TEST_RUNTIME_POLICY).toBe("node");
    expect(JSON.parse(node.env.OPENCLAW_NODE_TEST_GROUPS_JSON!)).toEqual([ui]);
    expect(existsSync(bun!.env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE!)).toBe(false);
    expect(invocations.at(-1)!.args).toContain("scripts/ci-run-node-test-shard.mts");
    expect(
      invocations.map(({ env }) => [
        env.OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER,
        env.OPENCLAW_NODE_COMPILE_CACHE_WRITER,
      ]),
    ).toEqual([...invocations.slice(0, -1).map(() => ["0", "0"]), ["1", "1"]]);
    const backend = invocations.find(({ args }) =>
      args.includes("scripts/ci-run-node-test-shard.mts"),
    )!;
    expect(backend.env.NODE_OPTIONS).toBe("--max-old-space-size=8192");
    expect(backend.env.OPENCLAW_CI_TEST_RUNTIME_POLICY).toBe(
      platform === "linux" ? "dual-all" : "bun-all",
    );
    expect(JSON.parse(backend.env.OPENCLAW_NODE_TEST_GROUPS_JSON!)).toEqual(
      platform === "linux" ? groups.filter((group) => group !== ui) : [groups[0]],
    );
    if (platform === "linux") {
      expect(invocations).toHaveLength(3);
    } else {
      expect(
        invocations
          .slice(0, 3)
          .map(({ args, env }) => [args[0], env.OPENCLAW_TEST_PROJECTS_PARALLEL]),
      ).toEqual([
        ["test", "3"],
        ["test:contracts:plugins", "1"],
        ["test:contracts:channels", "4"],
      ]);
      expect(invocations[0]!.args).toEqual([
        "test",
        ...groups[0]!.includePatterns!,
        "--testNamePattern=(?!)",
      ]);
    }
  },
);
