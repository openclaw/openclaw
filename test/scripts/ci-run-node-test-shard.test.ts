// Covers the CI node test shard runner: plan resolution from job env and
// bounded-concurrency execution with per-child Vitest cache isolation.
import * as childProcess from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChildEnv,
  clonePersistentCacheSlots,
  pruneFsModuleCache,
  resolveShardChildCommand,
  resolveShardPlans,
  resolveTestProjectsEntrypoint,
  runShardPlans,
} from "../../scripts/ci-run-node-test-shard.mts";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  ciTestShardRequiresBun,
  resolveCiTestRuntimeSelections,
} from "../../scripts/lib/ci-test-runtime.mts";
import { refitTestTimings } from "../../scripts/lib/ci-test-timings-refit.mts";
import { resolveLocalVitestScheduling } from "../../scripts/lib/vitest-local-scheduling.mts";
import * as groupOwner from "../../scripts/vitest-process-group.mts";
import { createDeferred } from "../helpers/promise.js";
import { getUnitFastIsolatedTestFiles } from "../vitest/vitest.unit-fast-paths.mjs";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

const scratchDirs: string[] = [];
const bunConfig = "test/vitest/vitest.unit-fast.config.ts";
const bunTarget = "packages/markdown-core/src/chunk-text.test.ts";
const nodeTarget = "test/scripts/update-restart-module-outcome.test.ts";

function makeScratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-shard-test-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("scripts/ci-run-node-test-shard.mts", () => {
  it.each(["stdout", "stderr"] as const)(
    "preserves workflow commands at column zero while labeling child %s",
    async (channel) => {
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(false);
      const child = new childProcess.ChildProcess();
      const streams = { stdout: new PassThrough(), stderr: new PassThrough() };
      child.stdout = streams.stdout;
      child.stderr = streams.stderr;
      const started = createDeferred();
      vi.spyOn(childProcess, "spawn").mockImplementation(() => {
        started.resolve();
        return child;
      });
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      const pending = runShardPlans(
        [{ kind: "group", name: "compact", plan: { configs: ["one.config.ts"] } }],
        { env: {}, scratchDir: makeScratchDir() },
      );
      await started.promise;
      const lines = [
        "ordinary output",
        "::error file=test/example.test.ts,line=12,title=failed::expected %25 to equal 2%0Atrace",
        "::warning file=test/example.test.ts::warning",
        "::notice::notice",
        "::group::failure details",
        "text containing ::error::is still ordinary output",
        "::errorish::is still ordinary output",
        "::endgroup::",
      ];
      const bytes = Buffer.from(lines.join("\n"));
      streams[channel].emit("data", bytes.subarray(0, 20));
      streams[channel].emit("data", bytes.subarray(20));
      child.emit("close", 1);
      await expect(pending).resolves.toBe(1);
      expect(output.join("")).toBe(
        [
          "[shard:compact] begin",
          `[shard:compact] ${lines[0]}`,
          ...lines.slice(1, 5),
          `[shard:compact] ${lines[5]}`,
          `[shard:compact] ${lines[6]}`,
          lines[7],
          "[shard:compact] end (exit 1)",
          "",
        ].join("\n"),
      );
    },
  );

  it("launches the current TypeScript child runner directly with Node", () => {
    expect(resolveShardChildCommand(["one.config.ts"], "/runtime/node")).toEqual({
      command: "/runtime/node",
      args: ["--import", "tsx", "scripts/test-projects.mts", "one.config.ts"],
    });
  });

  it("uses the compiled child runner from a frozen candidate", () => {
    const entrypoint = resolveTestProjectsEntrypoint((candidate) => candidate.endsWith(".mjs"));
    expect(entrypoint).toBe("scripts/test-projects.mjs");
    expect(resolveShardChildCommand(["one.config.ts"], "/runtime/node", entrypoint)).toEqual({
      command: "/runtime/node",
      args: ["scripts/test-projects.mjs", "one.config.ts"],
    });
  });

  it("fails clearly when the candidate has no test-projects entrypoint", () => {
    expect(() => resolveTestProjectsEntrypoint(() => false)).toThrow(
      "CI target does not provide scripts/test-projects.mts or .mjs",
    );
  });

  it("prefers explicit targets and keeps one target per child", () => {
    const plans = resolveShardPlans({
      OPENCLAW_NODE_TEST_TARGETS_JSON: JSON.stringify(["a.test.ts", "b.test.ts"]),
      OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([{ configs: ["c.config.ts"] }]),
    });
    expect(plans).toEqual([
      { kind: "target", name: "a.test.ts", target: "a.test.ts" },
      { kind: "target", name: "b.test.ts", target: "b.test.ts" },
    ]);
  });

  it("falls back from groups to the single-shard matrix envelope", () => {
    const groupPlans = resolveShardPlans({
      OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
        { configs: ["one.config.ts"], shard_name: "one", timing_key: "one#include-aaaa" },
        { configs: ["two.config.ts"], shard_name: "two" },
      ]),
    });
    expect(groupPlans.map((plan) => plan.name)).toEqual(["one", "two"]);
    expect(groupPlans.map((plan) => (plan.kind === "group" ? plan.timingKey : null))).toEqual([
      "one#include-aaaa",
      "two",
    ]);

    const singlePlans = resolveShardPlans({
      OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(["solo.config.ts"]),
      OPENCLAW_VITEST_SHARD_NAME: "solo",
    });
    expect(singlePlans).toHaveLength(1);
    expect(singlePlans[0]).toMatchObject({ kind: "group", name: "solo" });
  });

  it("unpacks the manifest's packed groups ahead of plain JSON groups", () => {
    const groups = [
      {
        configs: ["one.config.ts"],
        includePatterns: ["src/one.test.ts", "src/two.test.ts"],
        shard_name: "one",
        fallbackMaxWorkers: 2,
        minTotalMemoryBytes: 28 * 1024 ** 3,
        timing_key: "one#include-2-abcd",
      },
      { configs: ["two.config.ts"], env: { OPENCLAW_VITEST_MAX_WORKERS: "2" }, shard_name: "two" },
    ];
    const plans = resolveShardPlans({
      OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups(groups),
      OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([{ configs: ["stale.config.ts"] }]),
    });
    expect(plans).toEqual([
      { kind: "group", name: "one", plan: groups[0], timingKey: "one#include-2-abcd" },
      { kind: "group", name: "two", plan: groups[1], timingKey: "two" },
    ]);
    // A corrupt envelope must fail the job rather than silently run whole configs.
    expect(() =>
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: "bm90LWd6aXA=",
      }),
    ).toThrow();
  });

  it.each(["bun-compatible", "dual"] as const)(
    "preserves selected UI discovery before runtime partitioning under %s",
    async (policy) => {
      const bunFile = "ui/src/pages/skills/view.test.ts";
      const nodeFile = "ui/src/pages/chat/chat-pane-retained-presentation.test.ts";
      const includePatterns = [bunFile, nodeFile];
      const seen: Array<{ runtime: string | undefined; membership?: string[] }> = [];
      await expect(
        runShardPlans(
          [
            {
              kind: "group",
              name: "selected-ui",
              plan: { configs: ["ui/vitest.config.ts"], includePatterns },
            },
          ],
          {
            env: {
              OPENCLAW_CI_TEST_RUNTIME_POLICY: policy,
              OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--shard=1/3"]),
            },
            scratchDir: makeScratchDir(),
            runChild: async (_args, env) => {
              expect(JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8"))).toEqual(
                includePatterns,
              );
              seen.push({
                runtime: env.OPENCLAW_VITEST_RUNTIME,
                membership: env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE
                  ? JSON.parse(readFileSync(env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE, "utf8"))
                  : undefined,
              });
              return 0;
            },
          },
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([
        { runtime: "node", membership: policy === "dual" ? undefined : [nodeFile] },
        { runtime: "bun", membership: [bunFile] },
      ]);
    },
  );

  it.each([
    { policy: undefined, expected: ["eligible", "mixed", "unknown", bunTarget] },
    {
      policy: "bun-compatible",
      expected: ["bun:eligible", "mixed", "unknown", `bun:${bunTarget}`],
    },
    {
      policy: "dual",
      expected: ["eligible", "bun:eligible", "mixed", "unknown", bunTarget, `bun:${bunTarget}`],
    },
  ])("preserves complete process envelopes under $policy", async ({ policy, expected }) => {
    const persistentRoot = makeScratchDir();
    const seen: Array<{
      label: string;
      runtime: string | undefined;
      args: string[];
      cache: string | undefined;
    }> = [];
    let active = 0;
    let peakActive = 0;
    const groups = resolveShardPlans({
      OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
        { configs: [bunConfig], shard_name: "eligible", includePatterns: [bunTarget] },
        { configs: [bunConfig, "unknown.config.ts"], shard_name: "mixed" },
        { configs: ["unknown.config.ts"], shard_name: "unknown" },
      ]),
    });
    const exitCode = await runShardPlans(
      [...groups, { kind: "target", name: bunTarget, target: bunTarget }],
      {
        concurrency: 1,
        env: {
          OPENCLAW_CI_TEST_RUNTIME_POLICY: policy,
          OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: persistentRoot,
          OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--maxWorkers=1"]',
        },
        scratchDir: makeScratchDir(),
        runChild: async (args, env, label) => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          seen.push({
            label,
            runtime: env.OPENCLAW_VITEST_RUNTIME,
            args,
            cache: env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT,
          });
          if (label.endsWith("eligible")) {
            expect(JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8"))).toEqual([
              bunTarget,
            ]);
          }
          await Promise.resolve();
          active -= 1;
          return 0;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(peakActive).toBe(1);
    expect(seen.map(({ label }) => label)).toEqual(expected);
    for (const { label, runtime, args, cache } of seen) {
      const bun = label.startsWith("bun:");
      expect(runtime).toBe(bun ? "bun" : "node");
      expect(cache).toBe(path.join(persistentRoot, bun ? "vitest-cache-bun-0" : "vitest-cache-0"));
      const targets = label.endsWith("eligible")
        ? [bunConfig]
        : label === "mixed"
          ? [bunConfig, "unknown.config.ts"]
          : label === "unknown"
            ? ["unknown.config.ts"]
            : [bunTarget];
      expect(args).toEqual([...targets, "--", "--maxWorkers=1"]);
    }
  });

  it.each([
    { node: 7, bun: 0, expected: 7 },
    { node: 0, bun: 9, expected: 9 },
    { node: 7, bun: 9, expected: 7 },
  ])("finishes both runtimes and retains the first failure (node=$node, bun=$bun)", async (row) => {
    const runChild = vi.fn(async (_args: string[], env: NodeJS.ProcessEnv) =>
      env.OPENCLAW_VITEST_RUNTIME === "bun" ? row.bun : row.node,
    );
    await expect(
      runShardPlans(
        resolveShardPlans({
          OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
            { configs: [bunConfig], shard_name: "eligible" },
            { configs: ["later.config.ts"], shard_name: "later" },
          ]),
        }),
        {
          concurrency: 1,
          env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual" },
          scratchDir: makeScratchDir(),
          runChild,
        },
      ),
    ).resolves.toBe(row.expected);
    expect(runChild.mock.calls.map(([, env]) => env.OPENCLAW_VITEST_RUNTIME)).toEqual([
      "node",
      "bun",
    ]);
    expect(
      new Set(runChild.mock.calls.map(([, env]) => env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT)).size,
    ).toBe(2);
  });

  it("rejects an invalid runtime policy before scheduling any child", async () => {
    const runChild = vi.fn(async () => 0);
    await expect(
      runShardPlans([{ kind: "group", name: "one", plan: { configs: [bunConfig] } }], {
        env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "all-bun" },
        scratchDir: makeScratchDir(),
        runChild,
      }),
    ).rejects.toThrow("Invalid OPENCLAW_CI_TEST_RUNTIME_POLICY");
    expect(runChild).not.toHaveBeenCalled();
  });

  it.each([
    { policy: "bun-compatible", vitestArgs: [] },
    { policy: "dual", vitestArgs: [] },
    { policy: "dual", vitestArgs: ["--testNamePattern=(?!)", "--maxWorkers=1"] },
  ] as const)(
    "preserves runtime inventories under $policy with $vitestArgs",
    async ({ policy, vitestArgs }) => {
      const skippedOnBun = "src/process/spawn-broker/cleanup.test.ts";
      const v8HeapTest = "src/infra/worker-task-pool.memory.test.ts";
      const nodeHistoryBenchmark = "test/scripts/bench-session-history.test.ts";
      const nativeCompilerTest = "test/scripts/native-typescript.test.ts";
      const compilerGraphTest = "test/scripts/ts-topology.test.ts";
      const mixedCompilerTest = "src/plugin-sdk/provider-tools.test.ts";
      const nodeFiles = [
        skippedOnBun,
        v8HeapTest,
        nodeHistoryBenchmark,
        nativeCompilerTest,
        compilerGraphTest,
        mixedCompilerTest,
      ];
      const includePatterns = [bunTarget, ...nodeFiles];
      const shard = {
        configs: [bunConfig],
        includePatterns,
        shard_name: "partition",
        env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(vitestArgs) },
      };
      const seen: Array<{
        runtime: string | undefined;
        includes: string[];
        label: string;
        timing: string;
      }> = [];
      expect(ciTestShardRequiresBun(shard, policy)).toBe(true);
      await expect(
        runShardPlans(
          resolveShardPlans({
            OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([shard]),
          }),
          {
            concurrency: 1,
            env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
            scratchDir: makeScratchDir(),
            runChild: async (args, env, label, timing) => {
              expect(args).toEqual([
                bunConfig,
                ...(vitestArgs.length ? ["--", ...vitestArgs] : []),
              ]);
              seen.push({
                runtime: env.OPENCLAW_VITEST_RUNTIME,
                includes: JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8")),
                label,
                timing,
              });
              return 0;
            },
          },
        ),
      ).resolves.toBe(0);
      const nodePrefix = policy === "dual" ? "" : "node-subset:";
      expect(seen).toEqual([
        {
          runtime: "node",
          includes: policy === "dual" ? includePatterns : nodeFiles.toSorted(),
          label: `${nodePrefix}partition`,
          timing: `${nodePrefix}partition`,
        },
        { runtime: "bun", includes: [bunTarget], label: "bun:partition", timing: "bun:partition" },
      ]);
      expect(new Set(seen.flatMap(({ includes }) => includes))).toEqual(new Set(includePatterns));
    },
  );

  it("intersects unit-fast glob envelopes before partitioning runtimes", () => {
    expect(
      resolveCiTestRuntimeSelections(
        {
          configs: [bunConfig],
          includePatterns: [
            "packages/markdown-core/src/{chunk-text,render-aware-chunking}.test.ts",
          ],
        },
        "bun-compatible",
      ),
    ).toEqual([
      {
        runtime: "node",
        includePatterns: ["packages/markdown-core/src/render-aware-chunking.test.ts"],
      },
      { runtime: "bun", includePatterns: [bunTarget] },
    ]);
    expect(
      resolveCiTestRuntimeSelections(
        { configs: [bunConfig], includePatterns: [nodeTarget] },
        "bun-compatible",
      ),
    ).toEqual([{ runtime: "node" }]);
  });

  it.each(["bun-compatible", "dual"] as const)(
    "keeps isolated Node-dependent coverage without losing other files under %s",
    (policy) => {
      const config = "test/vitest/vitest.unit-fast-isolated.config.ts";
      const nodeFiles = [
        "src/agents/code-mode.action-output.test.ts",
        "src/proxy-capture/proxy-server.test.ts",
      ];
      const files = getUnitFastIsolatedTestFiles();
      const selection = { configs: [config] };
      const selected = resolveCiTestRuntimeSelections(selection, policy);
      expect(selected).toEqual([
        policy === "dual" ? { runtime: "node" } : { runtime: "node", includePatterns: nodeFiles },
        { runtime: "bun", includePatterns: files.filter((file) => !nodeFiles.includes(file)) },
      ]);
      expect(new Set(selected.flatMap(({ includePatterns }) => includePatterns ?? files))).toEqual(
        new Set(files),
      );
      expect(ciTestShardRequiresBun(selection, policy)).toBe(true);
      for (const nodeFile of nodeFiles) {
        expect(resolveCiTestRuntimeSelections({ targets: [nodeFile] }, policy)).toEqual([
          { runtime: "node" },
        ]);
        expect(
          resolveCiTestRuntimeSelections(
            { configs: [config], includePatterns: [nodeFile] },
            policy,
          ),
        ).toEqual([{ runtime: "node" }]);
      }
      expect(resolveCiTestRuntimeSelections({ targets: ["src/version.test.ts"] }, policy)).toEqual(
        policy === "dual" ? [{ runtime: "node" }, { runtime: "bun" }] : [{ runtime: "bun" }],
      );
    },
  );

  it.each([
    { env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--shard=1/2"]' } },
    { env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--root=another-root"]' } },
    { env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--project=another-project"]' } },
    { env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--config=another.config.ts"]' } },
    { env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--testNamePattern=one case"]' } },
    {
      env: {
        OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--testNamePattern=(?!)","--project=other"]',
      },
    },
    {
      env: {
        OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--testNamePattern=(?!)","--testNamePattern=one"]',
      },
    },
    { env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: "invalid" } },
    { env: { OPENCLAW_VITEST_INCLUDE_FILE: "external.json" } },
    { configs: [bunConfig, "test/vitest/vitest.unit-fast-fake-timers.config.ts"] },
    { targets: ["packages/markdown-core/src"] },
    { targets: ["packages/markdown-core/src/*.test.ts"] },
    { targets: [bunTarget, nodeTarget] },
  ])("keeps ambiguous selection contracts on Node: %s", (selection) => {
    const shard = { configs: [bunConfig], ...selection };
    expect(resolveCiTestRuntimeSelections(shard, "bun-compatible")).toEqual([{ runtime: "node" }]);
    expect(resolveCiTestRuntimeSelections(shard, "dual")).toEqual([{ runtime: "node" }]);
    if (!selection.targets) {
      expect(ciTestShardRequiresBun(shard, "dual")).toBe(false);
    }
  });

  it("retains complete proven fake-timer coverage on both release runtimes", () => {
    const selection = { configs: ["test/vitest/vitest.unit-fast-fake-timers.config.ts"] };
    expect(resolveCiTestRuntimeSelections(selection, "bun-compatible")).toEqual([
      { runtime: "bun" },
    ]);
    expect(resolveCiTestRuntimeSelections(selection, "dual")).toEqual([
      { runtime: "node" },
      { runtime: "bun" },
    ]);
  });

  it.each(["bun-compatible", "dual"] as const)(
    "applies the measured UI JIT policy only to the Bun child under %s",
    async (policy) => {
      const seen: Array<Record<string, string | undefined>> = [];
      await expect(
        runShardPlans([{ kind: "group", name: "ui", plan: { configs: ["ui/vitest.config.ts"] } }], {
          env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
          scratchDir: makeScratchDir(),
          runChild: async (_args, env) => {
            seen.push({
              runtime: env.OPENCLAW_VITEST_RUNTIME,
              warmup: env.BUN_JSC_thresholdForFTLOptimizeAfterWarmUp,
              soon: env.BUN_JSC_thresholdForFTLOptimizeSoon,
              ftlEnabled: env.BUN_JSC_useFTLJIT,
            });
            return 0;
          },
        }),
      ).resolves.toBe(0);
      expect(seen).toEqual([
        { runtime: "node", warmup: undefined, soon: undefined, ftlEnabled: undefined },
        { runtime: "bun", warmup: "512000", soon: "8000", ftlEnabled: undefined },
      ]);
    },
  );

  it.each([
    { vitestArgs: ["--root=another-root"] },
    { vitestArgs: ["--config", "another.config.ts"] },
    { vitestArgs: ["--pool=threads"] },
    { vitestArgs: ["--watch"] },
    { vitestArgs: ["--shard=4/3"] },
    { vitestArgs: ["--reporter=custom.mts"] },
    { vitestArgs: ["--maxWorkers"] },
    { targets: ["ui/src/pages/skills/view.test.ts"] },
    { configs: [], targets: ["ui/src/pages/skills/view.test.ts"], env: {} },
    { configs: ["ui/vitest.config.ts", bunConfig] },
    {
      env: { OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: "external.json" },
    },
  ])("keeps unproven UI execution envelopes on Node: %s", (overrides) => {
    const selection = {
      configs: ["ui/vitest.config.ts"],
      ...overrides,
    };
    expect(resolveCiTestRuntimeSelections(selection, "dual")).toEqual([{ runtime: "node" }]);
    expect(ciTestShardRequiresBun(selection, "bun-compatible")).toBe(false);
  });

  it.each([
    { shard: { configs: [bunConfig] }, expected: true },
    { shard: { configs: [] }, expected: false },
    { shard: { configs: [bunConfig, "unknown.config.ts"] }, expected: false },
    {
      shard: { groups: [{ configs: [bunConfig] }, { configs: ["unknown.config.ts"] }] },
      expected: true,
    },
    { shard: { targets: [bunTarget] }, expected: true },
    { shard: { targets: [nodeTarget] }, expected: false },
    { shard: { targets: ["test/scripts/ci-run-node-test-shard.test.ts"] }, expected: false },
    {
      shard: { targets: ["test/scripts/ci-run-node-test-shard.test.ts"], configs: [bunConfig] },
      expected: false,
    },
  ])(
    "installs Bun only for a shard with an admitted process envelope: $shard",
    ({ shard, expected }) => {
      expect(ciTestShardRequiresBun(shard, "bun-compatible")).toBe(expected);
      expect(ciTestShardRequiresBun(shard, "dual")).toBe(expected);
      expect(ciTestShardRequiresBun(shard, "node")).toBe(false);
    },
  );

  it("builds child env with per-plan cache isolation, includes, and env overlays", () => {
    const scratchDir = makeScratchDir();
    const entry = {
      kind: "group" as const,
      name: "g",
      plan: {
        configs: ["cfg.ts"],
        env: { EXTRA: "yes", IGNORED: 42 },
        includePatterns: ["src/a.test.ts"],
        shard_name: "g",
      },
    };
    const childEnv = buildChildEnv(
      entry,
      { BASE: "1", OPENCLAW_VITEST_INCLUDE_FILE: "stale.json" },
      scratchDir,
      3,
    );
    expect(childEnv.BASE).toBe("1");
    expect(childEnv.EXTRA).toBe("yes");
    expect(childEnv.IGNORED).toBeUndefined();
    expect(childEnv.OPENCLAW_VITEST_SHARD_NAME).toBe("g");
    expect(childEnv.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe("1");
    expect(childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT).toBe(
      path.join(scratchDir, "vitest-cache-3"),
    );
    expect(childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBeUndefined();
    expect(childEnv.OPENCLAW_VITEST_INCLUDE_FILE).toBe(
      path.join(scratchDir, "node-test-include-3.json"),
    );
    expect(JSON.parse(readFileSync(childEnv.OPENCLAW_VITEST_INCLUDE_FILE ?? "", "utf8"))).toEqual([
      "src/a.test.ts",
    ]);

    const bare = buildChildEnv(
      { kind: "group" as const, name: "bare", plan: { configs: ["cfg.ts"] } },
      { OPENCLAW_VITEST_INCLUDE_FILE: "stale.json" },
      scratchDir,
      0,
    );
    expect(bare.OPENCLAW_VITEST_INCLUDE_FILE).toBeUndefined();

    const explicit = buildChildEnv(
      { kind: "group", name: "explicit", plan: { configs: ["cfg.ts"] } },
      {
        OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: scratchDir,
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "caller-leaf",
      },
      scratchDir,
      0,
      { runtime: "bun" },
    );
    expect(explicit.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT).toBe(
      path.join(scratchDir, "vitest-cache-bun-0"),
    );
    expect(explicit.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBe("caller-leaf");
  });

  it.each([
    { job: "1", group: "2", expected: 1 },
    { job: "1", group: "", expected: 1 },
    { job: "1", group: "  ", expected: 1 },
    { job: "2", group: "2", expected: 2 },
    { job: "3", group: "2", expected: 2 },
    { job: "4", group: "2", expected: 2 },
    { job: "6", group: "2", expected: 2 },
    { job: "6", group: "1", expected: 1 },
    { job: undefined, group: "2", expected: 2 },
    { job: "6", group: undefined, expected: 6 },
    { job: "1", group: undefined, expected: 1, target: true },
  ])(
    "intersects inherited worker ceiling $job with group cap $group (target=$target)",
    ({ job, group, expected, target }) => {
      const childEnv = buildChildEnv(
        target
          ? { kind: "target", name: "one", target: "one.test.ts" }
          : {
              kind: "group",
              name: "one",
              plan: {
                configs: ["one.config.ts"],
                env: { OPENCLAW_VITEST_MAX_WORKERS: group, EXTRA: "group" },
              },
            },
        { CI: "true", OPENCLAW_VITEST_MAX_WORKERS: job, EXTRA: "job" },
        makeScratchDir(),
        0,
      );
      expect(childEnv.OPENCLAW_VITEST_MAX_WORKERS).toBe(String(expected));
      expect(childEnv.EXTRA).toBe(target ? "job" : "group");
      expect(resolveLocalVitestScheduling(childEnv, { cpuCount: Number(job) || 8 })).toEqual({
        maxWorkers: expected,
        fileParallelism: expected > 1,
        throttledBySystem: false,
      });
    },
  );

  it.each([
    { key: "NODE_OPTIONS", shared: true },
    { key: "NODE_OPTIONS", shared: false },
    { key: "NODE_PATH", shared: true },
    { key: "NODE_PATH", shared: false },
  ])(
    "reconciles compiler $key only for shared ownership (shared=$shared)",
    async ({ key, shared }) => {
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(shared);
      const scratchDir = makeScratchDir();
      const runChild = vi.fn(async (_args: string[], _env: NodeJS.ProcessEnv) => 0);
      const plans = resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
          { configs: ["one.config.ts"], includePatterns: ["src/one.test.ts"] },
          { configs: ["two.config.ts"], env: { [key]: "different-loader" } },
        ]),
      });
      const pending = runShardPlans(plans, { env: {}, scratchDir, runChild });
      if (shared) {
        await expect(pending).rejects.toThrow(
          `CI groups cannot share a compiler with differing ${key}`,
        );
        expect(runChild).not.toHaveBeenCalled();
        expect(readdirSync(scratchDir)).toEqual([]);
      } else {
        await expect(pending).resolves.toBe(0);
        const childEnvs = runChild.mock.calls.map(([, env]) => env);
        expect(childEnvs.map((env) => env[key])).toEqual([undefined, "different-loader"]);
        expect(
          JSON.parse(readFileSync(childEnvs[0]!.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8")),
        ).toEqual(["src/one.test.ts"]);
        expect(childEnvs[1]!.OPENCLAW_VITEST_INCLUDE_FILE).toBeUndefined();
      }
    },
  );

  it.each<
    readonly [
      name: string,
      cpus: number,
      gib: number,
      ci: string | undefined,
      actions: string | undefined,
      requested: number,
      expected: number,
      config: string | undefined,
    ]
  >([
    ["local explicit concurrency", 2, 16, undefined, undefined, 3, 3, undefined],
    ["CI capacity boundary", 8, 24, "true", undefined, 2, 2, undefined],
    ["CPU-constrained CI", 4, 32, "true", undefined, 2, 1, undefined],
    ["memory-constrained CI", 8, 16, "true", undefined, 2, 1, undefined],
    ["unknown CI CPUs", Number.NaN, 32, "true", undefined, 2, 1, undefined],
    ["unknown CI memory", 8, Number.NaN, "true", undefined, 2, 1, undefined],
    ["CI two-plan ceiling", 16, 64, "true", undefined, 3, 2, undefined],
    ["GitHub Actions capacity", 4, 32, undefined, "true", 2, 1, undefined],
    ...[
      "gateway-core",
      "gateway-database-workers",
      "gateway-methods",
      "gateway-methods-isolated",
      "gateway-server",
      "gateway-server-isolated",
    ].map(
      (name) =>
        [name, 8, 24, "true", undefined, 2, 1, `test/vitest/vitest.${name}.config.ts`] as const,
    ),
    [
      "Gateway client remains parallel",
      8,
      24,
      "true",
      undefined,
      2,
      2,
      "test/vitest/vitest.gateway-client.config.ts",
    ],
  ])(
    "runs plans with bounded concurrency and cache isolation for %s",
    async (_name, cpus, gib, ci, actions, requested, expected, config) => {
      vi.spyOn(os, "availableParallelism").mockReturnValue(cpus);
      vi.spyOn(os, "totalmem").mockReturnValue(gib * 1024 ** 3);
      const scratchDir = makeScratchDir();
      const seen: Array<{
        args: string[];
        cache: string | undefined;
        label: string;
        workers: string | undefined;
      }> = [];
      let active = 0;
      let peakActive = 0;
      const exitCode = await runShardPlans(
        resolveShardPlans({
          OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
            {
              configs: [config ?? "a.config.ts"],
              shard_name: "a",
              env: { OPENCLAW_VITEST_MAX_WORKERS: "6" },
            },
            { configs: ["b.config.ts"], shard_name: "b" },
            { configs: ["c.config.ts"], shard_name: "c" },
          ]),
        }),
        {
          concurrency: ci || actions ? undefined : requested,
          env: {
            CI: ci,
            GITHUB_ACTIONS: actions,
            OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: String(requested),
            OPENCLAW_VITEST_MAX_WORKERS: "4",
            OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify({ OPENCLAW_VITEST_MAX_WORKERS: "2" }),
          },
          runChild: async (
            args: string[],
            childEnv: Record<string, string | undefined>,
            label: string,
          ) => {
            active += 1;
            peakActive = Math.max(peakActive, active);
            await Promise.resolve();
            seen.push({
              args,
              cache: childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT,
              label,
              workers: childEnv.OPENCLAW_VITEST_MAX_WORKERS,
            });
            active -= 1;
            return 0;
          },
          scratchDir,
        },
      );
      expect(exitCode).toBe(0);
      expect(peakActive).toBe(expected);
      expect(seen.map((run) => run.workers)).toEqual(["2", "2", "2"]);
      expect(seen.map((run) => run.label).toSorted()).toEqual(["a", "b", "c"]);
      expect(new Set(seen.map((run) => run.cache)).size).toBe(expected === 1 ? 1 : 3);
    },
  );

  it.each([
    { name: "measured host", cpus: 8, gib: 31, runner: "self-hosted", expected: "8" },
    { name: "shared memory floor", cpus: 8, gib: 24, runner: "self-hosted", expected: "8" },
    {
      name: "below group memory floor",
      cpus: 8,
      gib: 24,
      minGib: 28,
      runner: "self-hosted",
      expected: "2",
    },
    {
      name: "at group memory floor",
      cpus: 8,
      gib: 28,
      minGib: 28,
      runner: "self-hosted",
      expected: "8",
    },
    {
      name: "larger host retains group cap",
      cpus: 16,
      gib: 31,
      minGib: 28,
      runner: "self-hosted",
      cap: "8",
      requested: "16",
      expected: "8",
    },
    { name: "constrained CPUs", cpus: 4, gib: 31, runner: "self-hosted", expected: "2" },
    { name: "constrained memory", cpus: 8, gib: 16, runner: "self-hosted", expected: "2" },
    { name: "hosted fallback", cpus: 8, gib: 31, runner: "github-hosted", expected: "2" },
    { name: "unknown runner", cpus: 8, gib: 31, runner: undefined, expected: "2" },
    {
      name: "frozen target",
      cpus: 8,
      gib: 31,
      runner: "self-hosted",
      frozen: "true",
      expected: "2",
    },
    {
      name: "explicit lower cap",
      cpus: 4,
      gib: 31,
      runner: "self-hosted",
      cap: "1",
      expected: "1",
    },
    {
      name: "overlapping plans",
      cpus: 8,
      gib: 31,
      runner: "self-hosted",
      parallel: true,
      expected: "2",
    },
  ])(
    "retains the measured group's fallback ceiling on $name",
    async ({ cpus, gib, minGib, runner, frozen, cap, requested, parallel, expected }) => {
      vi.spyOn(os, "availableParallelism").mockReturnValue(cpus);
      vi.spyOn(os, "totalmem").mockReturnValue(gib * 1024 ** 3);
      const runChild = vi.fn(async (_args: string[], _env: NodeJS.ProcessEnv) => 0);
      const plans = resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups([
          {
            configs: ["measured.config.ts"],
            fallbackMaxWorkers: 2,
            minTotalMemoryBytes: minGib === undefined ? undefined : minGib * 1024 ** 3,
            env: { OPENCLAW_VITEST_MAX_WORKERS: cap },
          },
          { configs: ["ordinary.config.ts"] },
        ]),
      });
      await expect(
        runShardPlans(plans, {
          env: {
            CI: "true",
            RUNNER_ENVIRONMENT: runner,
            FROZEN_TARGET: frozen,
            OPENCLAW_VITEST_MAX_WORKERS: requested ?? "8",
            OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: parallel ? "2" : "1",
          },
          scratchDir: makeScratchDir(),
          runChild,
        }),
      ).resolves.toBe(0);
      expect(runChild.mock.calls.map(([, env]) => env.OPENCLAW_VITEST_MAX_WORKERS)).toEqual([
        expected,
        requested ?? "8",
      ]);
    },
  );

  it("keeps Bun timings separate from Node membership timing spans", async () => {
    const timingKey =
      "agentic-agents-support#selector-2-aaaa#generation-bbbb#part-1-of-2#include-1-cccc";
    const lines: string[] = [];
    const exitCode = await runShardPlans(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
          {
            configs: [bunConfig],
            shard_name: "agentic-agents-support-hosted-1",
            timing_key: timingKey,
          },
        ]),
      }),
      {
        concurrency: 1,
        env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual" },
        runChild: async (_args, _childEnv, label, spanKey) => {
          lines.push(`2026-08-27T23:00:00Z [shard:${spanKey}] begin`);
          lines.push(`2026-08-27T23:00:01Z [shard:${label}] child output`);
          lines.push(
            `2026-08-27T23:00:${spanKey.startsWith("bun:") ? "03" : "10"}Z [shard:${spanKey}] end (exit 0)`,
          );
          return 0;
        },
        scratchDir: makeScratchDir(),
      },
    );

    expect(exitCode).toBe(0);
    expect(lines[1]).toContain("[shard:agentic-agents-support-hosted-1] child output");
    const runs = [1, 2].map((id) => ({
      id,
      createdAt: `2026-08-${26 + id}T23:00:00Z`,
      completeInventory: false,
      logs: [{ kind: "compact" as const, labels: ["blacksmith-16vcpu"], text: lines.join("\n") }],
    }));
    expect(refitTestTimings(runs).timings.compactGroupSeconds.blacksmith[timingKey]).toBe(10);
    expect(refitTestTimings(runs).timings.compactGroupSeconds.blacksmith[`bun:${timingKey}`]).toBe(
      3,
    );
  });

  it.each([
    { source: "option", concurrency: 3, env: {} },
    {
      source: "environment",
      concurrency: undefined,
      env: { OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "3" },
    },
    { source: "default", concurrency: undefined, env: {} },
  ])(
    "bounds $source workers and restored cache slots to actual plans",
    async ({ env, concurrency }) => {
      const persistentRoot = makeScratchDir();
      const seed = path.join(persistentRoot, "vitest-cache-0");
      mkdirSync(seed);
      writeFileSync(path.join(seed, "transform"), "cached", "utf8");
      const seen: string[] = [];
      const exitCode = await runShardPlans(
        [{ kind: "group", name: "one", plan: { configs: ["one.config.ts"] } }],
        {
          concurrency,
          env: { ...env, OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: persistentRoot },
          scratchDir: makeScratchDir(),
          runChild: async (_args, childEnv) => {
            seen.push(childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT ?? "");
            return 0;
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(seen).toEqual([seed]);
      expect(readdirSync(persistentRoot)).toEqual(["vitest-cache-0"]);
    },
  );

  it.each([Number.NaN, 0, 1.5])(
    "rejects invalid concurrency %s before scheduling plans",
    async (concurrency) => {
      let runs = 0;
      await expect(
        runShardPlans([{ kind: "group", name: "one", plan: { configs: ["one.config.ts"] } }], {
          concurrency,
          env: {},
          scratchDir: makeScratchDir(),
          runChild: async () => {
            runs += 1;
            return 0;
          },
        }),
      ).rejects.toThrow("Shard plan concurrency must be a positive integer");
      expect(runs).toBe(0);
    },
  );

  it("runs same-config envelopes serially through one persistent cache slot", async () => {
    const scratchDir = makeScratchDir();
    const persistentRoot = path.join(makeScratchDir(), "persistent");
    mkdirSync(persistentRoot, { recursive: true });
    const seen: Array<{
      args: string[];
      cache: string | undefined;
      label: string;
      includeFile: string | undefined;
    }> = [];
    const started = createDeferred();
    const held = createDeferred();

    const pending = runShardPlans(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
          ["a", "b", "c"].map((name) => ({
            configs: ["plugin.config.ts"],
            includePatterns: [`extensions/fixture/${name}.test.ts`],
            shard_name: `envelope:${name}`,
          })),
        ),
      }),
      {
        concurrency: 1,
        env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: persistentRoot },
        runChild: async (
          args: string[],
          childEnv: Record<string, string | undefined>,
          label: string,
        ) => {
          seen.push({
            args,
            cache: childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT,
            label,
            includeFile: childEnv.OPENCLAW_VITEST_INCLUDE_FILE,
          });
          if (label === "envelope:a") {
            started.resolve();
            await held.promise;
          }
          return 0;
        },
        scratchDir,
      },
    );

    try {
      await started.promise;
      await nextTurn();
      expect(seen.map((run) => run.label)).toEqual(["envelope:a"]);
    } finally {
      held.resolve();
      await expect(pending).resolves.toBe(0);
    }
    expect(seen.map((run) => run.args)).toEqual([
      ["plugin.config.ts"],
      ["plugin.config.ts"],
      ["plugin.config.ts"],
    ]);
    expect(seen.map((run) => run.label)).toEqual(["envelope:a", "envelope:b", "envelope:c"]);
    expect(new Set(seen.map((run) => run.includeFile)).size).toBe(3);
    expect(seen.map((run) => JSON.parse(readFileSync(run.includeFile ?? "", "utf8")))).toEqual([
      ["extensions/fixture/a.test.ts"],
      ["extensions/fixture/b.test.ts"],
      ["extensions/fixture/c.test.ts"],
    ]);
    expect(new Set(seen.map((run) => run.cache))).toEqual(
      new Set([path.join(persistentRoot, "vitest-cache-0")]),
    );
  });

  it.each([undefined, "--shard=3/6"])(
    "resolves job and group Vitest arguments once (job partition %s)",
    async (jobPartition) => {
      const scratchDir = makeScratchDir();
      const seen: string[][] = [];
      const exitCode = await runShardPlans(
        resolveShardPlans({
          OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
            {
              configs: ["test/vitest/vitest.extensions.config.ts"],
              env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--shard=1/6"]) },
            },
            {
              configs: ["test/vitest/vitest.extensions.config.ts"],
              env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--shard=2/6"]) },
            },
            { configs: ["test/vitest/vitest.unit.config.ts"] },
          ]),
        }),
        {
          concurrency: 1,
          env: {
            OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--hookTimeout=300000"]),
            OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify(
              jobPartition
                ? {
                    OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify([jobPartition]),
                  }
                : {},
            ),
          },
          runChild: async (args: string[]) => {
            seen.push(args);
            return 0;
          },
          scratchDir,
        },
      );

      expect(exitCode).toBe(0);
      expect(seen).toEqual([
        ["test/vitest/vitest.extensions.config.ts", "--", "--hookTimeout=300000", "--shard=1/6"],
        ["test/vitest/vitest.extensions.config.ts", "--", "--hookTimeout=300000", "--shard=2/6"],
        [
          "test/vitest/vitest.unit.config.ts",
          "--",
          "--hookTimeout=300000",
          ...(jobPartition ? [jobPartition] : []),
        ],
      ]);
    },
  );

  it("reuses isolated persistent cache slots across serial work", async () => {
    const scratchDir = makeScratchDir();
    const persistentRoot = path.join(makeScratchDir(), "persistent");
    mkdirSync(persistentRoot, { recursive: true });
    const seenCaches = new Set<string>();
    const activeCaches = new Set<string>();
    let sharedWriter = false;
    const exitCode = await runShardPlans(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
          ["a", "b", "c", "d"].map((name) => ({
            configs: [`${name}.config.ts`],
            shard_name: name,
          })),
        ),
      }),
      {
        concurrency: 2,
        env: { OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: persistentRoot },
        runChild: async (_args: string[], childEnv: Record<string, string | undefined>) => {
          const cache = childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT ?? "";
          if (activeCaches.has(cache)) {
            sharedWriter = true;
          }
          activeCaches.add(cache);
          seenCaches.add(cache);
          await Promise.resolve();
          activeCaches.delete(cache);
          return 0;
        },
        scratchDir,
      },
    );

    expect(exitCode).toBe(0);
    expect(sharedWriter).toBe(false);
    expect([...seenCaches].toSorted()).toEqual([
      path.join(persistentRoot, "vitest-cache-0"),
      path.join(persistentRoot, "vitest-cache-1"),
    ]);
  });

  it.each([
    { prefixes: ["vitest-cache"] },
    { prefixes: ["vitest-cache-bun"] },
    { prefixes: ["vitest-cache", "vitest-cache-bun"] },
  ])("clones restored runtime seeds into isolated concurrent slots: $prefixes", ({ prefixes }) => {
    const persistentRoot = makeScratchDir();
    for (const prefix of prefixes) {
      const seed = path.join(persistentRoot, `${prefix}-0`);
      mkdirSync(seed, { recursive: true });
      writeFileSync(path.join(seed, "transform"), prefix, "utf8");
      const staleSlot = path.join(persistentRoot, `${prefix}-1`);
      mkdirSync(staleSlot, { recursive: true });
      writeFileSync(path.join(staleSlot, "stale"), "old", "utf8");
    }

    expect(clonePersistentCacheSlots(persistentRoot, 3)).toBe(prefixes.length * 2);
    for (const prefix of prefixes) {
      for (const cacheSlot of [1, 2]) {
        expect(
          readFileSync(path.join(persistentRoot, `${prefix}-${cacheSlot}`, "transform"), "utf8"),
        ).toBe(prefix);
      }
      expect(existsSync(path.join(persistentRoot, `${prefix}-1`, "stale"))).toBe(false);
      writeFileSync(path.join(persistentRoot, `${prefix}-1`, "transform"), "changed", "utf8");
      expect(readFileSync(path.join(persistentRoot, `${prefix}-0`, "transform"), "utf8")).toBe(
        prefix,
      );
    }
  });

  it("prunes oldest transform entries while preserving Vitest metadata", () => {
    const persistentRoot = makeScratchDir();
    const slot = path.join(persistentRoot, "vitest-cache-0");
    mkdirSync(slot, { recursive: true });
    const metadata = path.join(slot, "_metadata.json");
    const generation = path.join(persistentRoot, ".openclaw-transform-generation");
    const oldest = path.join(slot, "oldest");
    const newest = path.join(slot, "newest");
    writeFileSync(metadata, "{}", "utf8");
    writeFileSync(generation, "g", "utf8");
    writeFileSync(oldest, "aaaaaaaa", "utf8");
    writeFileSync(newest, "bbbbbbbb", "utf8");
    utimesSync(oldest, new Date(1_000), new Date(1_000));
    utimesSync(newest, new Date(2_000), new Date(2_000));

    expect(pruneFsModuleCache(persistentRoot, 16)).toEqual({
      beforeBytes: 19,
      afterBytes: 11,
      removedFiles: 1,
    });
    expect(existsSync(metadata)).toBe(true);
    expect(existsSync(generation)).toBe(true);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  it("prunes persistent caches only in the designated writer job", async () => {
    const persistentRoot = makeScratchDir();
    const transform = path.join(persistentRoot, "vitest-cache-0", "entry");
    mkdirSync(path.dirname(transform), { recursive: true });
    writeFileSync(transform, "cached", "utf8");
    const plans = resolveShardPlans({
      OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(["test/vitest/vitest.unit.config.ts"]),
    });
    const run = (writer: string) =>
      runShardPlans(plans, {
        concurrency: 1,
        env: {
          OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: persistentRoot,
          OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER: writer,
        },
        fsModuleCacheMaxBytes: 0,
        runChild: async () => 0,
        scratchDir: makeScratchDir(),
      });

    await run("0");
    expect(existsSync(transform)).toBe(true);
    await run("1");
    expect(existsSync(transform)).toBe(false);
  });

  it.each(["exit", "rejection"] as const)(
    "joins admitted plans and stops scheduling after a %s failure",
    async (failure) => {
      const started: string[] = [];
      const held = createDeferred();
      const failed = createDeferred();
      const children: Promise<number>[] = [];
      const error = new Error("second child rejected");
      let settled = false;
      const pending = runShardPlans(
        resolveShardPlans({
          OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
            ["a", "b", "c", "d"].map((name) => ({
              configs: [`${name}.config.ts`],
              shard_name: name,
            })),
          ),
        }),
        {
          concurrency: 2,
          env: {},
          scratchDir: makeScratchDir(),
          runChild: (_args, _env, label) => {
            const child = (async () => {
              started.push(label);
              if (label === "a") {
                await held.promise;
              }
              if (label === "b") {
                failed.resolve();
                if (failure === "rejection") {
                  throw error;
                }
                return 7;
              }
              return 0;
            })();
            children.push(child);
            return child;
          },
        },
      )
        .then(
          (exitCode) => ({ exitCode, error: undefined }),
          (cause: unknown) => ({ exitCode: undefined, error: cause }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await failed.promise;
        await nextTurn();
        expect(settled).toBe(false);
        expect(started).toEqual(["a", "b"]);
      } finally {
        held.resolve();
        await nextTurn();
        await Promise.allSettled(children);
        await pending;
      }
      const outcome = await pending;
      if (failure === "rejection") {
        expect(outcome.error).toBe(error);
      } else {
        expect(outcome.exitCode).toBe(7);
      }
      expect(started).toEqual(["a", "b"]);
    },
  );

  it("continues through failed plans only when explicitly requested", async () => {
    const started: string[] = [];
    const exitCode = await runShardPlans(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
          ["a", "b", "c", "d"].map((name) => ({
            configs: [`${name}.config.ts`],
            shard_name: name,
          })),
        ),
      }),
      {
        concurrency: 1,
        continueOnFailure: true,
        env: {},
        runChild: async (_args, _env, label) => {
          started.push(label);
          return label === "b" ? 7 : label === "d" ? 9 : 0;
        },
        scratchDir: makeScratchDir(),
      },
    );

    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(exitCode).toBe(7);
  });

  it.each([
    { continueOnFailure: false, expectedStarted: [] },
    { continueOnFailure: true, expectedStarted: ["next"] },
  ])(
    "fails a malformed plan with continuation=$continueOnFailure",
    async ({ continueOnFailure, expectedStarted }) => {
      const started: string[] = [];
      const exitCode = await runShardPlans(
        [
          { kind: "group" as const, name: "broken", plan: { configs: [] } },
          { kind: "group" as const, name: "next", plan: { configs: ["next.config.ts"] } },
        ],
        {
          concurrency: 1,
          continueOnFailure,
          env: {},
          runChild: async (_args, _env, label) => {
            started.push(label);
            return 0;
          },
          scratchDir: makeScratchDir(),
        },
      );

      expect(exitCode).toBe(1);
      expect(started).toEqual(expectedStarted);
    },
  );
});
