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
import * as fsPromises from "node:fs/promises";
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
import nativeBunQualification from "../../scripts/lib/ci-test-native-bun-qualification.json" with { type: "json" };
import {
  ciTestShardRequiresBun,
  resolveCiTestRuntimeSelections,
} from "../../scripts/lib/ci-test-runtime.mts";
import { refitTestTimings } from "../../scripts/lib/ci-test-timings-refit.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveLocalVitestScheduling } from "../../scripts/lib/vitest-local-scheduling.mts";
import * as workerOwner from "../../scripts/lib/vitest-worker-run.mts";
import * as groupOwner from "../../scripts/vitest-process-group.mts";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";

const nativeQualificationFixtures = vi.hoisted(() => ({
  first: "packages/markdown-core/src/chunk-text.test.ts",
  second: "src/utils/chunk-items.test.ts",
  helperTest: "src/agents/embedded-agent-runner/run/compaction-timeout.test.ts",
  helper: "src/agents/test-helpers/agent-message-fixtures.ts",
  setup: "test/setup.env.ts",
}));

vi.mock("../../scripts/lib/ci-test-native-bun-qualification.json", async () => {
  const { createHash } = await import("node:crypto");
  const { readFileSync: readQualificationSource } = await import("node:fs");
  const hash = (file: string) =>
    createHash("sha256").update(readQualificationSource(file)).digest("hex");
  const { first, second, helperTest, helper, setup } = nativeQualificationFixtures;
  return {
    default: {
      setup: { [setup]: hash(setup) },
      tests: Object.fromEntries([first, second, helperTest].map((file) => [file, hash(file)])),
      helpers: { [helperTest]: { [helper]: hash(helper) } },
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const scratchDirs: string[] = [];
const bunConfig = "test/vitest/vitest.unit-fast.config.ts";
const unitConfig = "test/vitest/vitest.unit.config.ts";
const unitSrcConfig = "test/vitest/vitest.unit-src.config.ts";
const libraryTarget = "src/library.test.ts";
const bunTarget = nativeQualificationFixtures.first;
const vitestBunTarget = "src/agents/sandbox/docker.execDockerRaw.enoent.test.ts";
const nativeBunTarget = nativeQualificationFixtures.second;
const nodeTarget = "test/scripts/update-restart-module-outcome.test.ts";
const agentsSupportConfig = "test/vitest/vitest.agents-support.config.ts";
const worktreeRecoveryTarget = "src/agents/worktrees/service.removal-recovery.test.ts";
const embeddedRunConfig = "test/vitest/vitest.agents-embedded-agent-run.config.ts";
const transcriptLifecycleTarget =
  "src/agents/embedded-agent-runner/run/attempt-transcript-lifecycle.test.ts";
const gatewayCoreConfig = "test/vitest/vitest.gateway-core.config.ts";
const gatewayClientConfig = "test/vitest/vitest.gateway-client.config.ts";
const gatewayClientTarget = "src/gateway/talk/handlers/client-native-control.test.ts";
const memoryConfig = "test/vitest/vitest.extension-memory.config.ts";
const memoryTarget = "extensions/memory-lancedb/config.test.ts";
const memoryIncludes = ["extensions/memory-lancedb", "extensions/memory-wiki"];

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
  it.each([0, 23])(
    "settles package preparation before starting shard readers (exit %s)",
    async (code) => {
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(false);
      const started = createDeferred();
      const prepared = createDeferred<number>();
      vi.spyOn(buildPrerequisites, "preparePrebuiltAiPackage").mockImplementation(async () => {
        started.resolve();
        return prepared.promise;
      });
      const runChild = vi.fn().mockResolvedValue(0);
      const pending = runShardPlans(
        [{ kind: "target", name: "AI package", target: "packages/ai/src/package.e2e.test.ts" }],
        {
          env: { OPENCLAW_E2E_USE_PREBUILT_DIST: "1" },
          scratchDir: makeScratchDir(),
          runChild,
        },
      );
      await started.promise;
      expect(runChild).not.toHaveBeenCalled();
      prepared.resolve(code);
      expect(await pending).toBe(code);
      expect(runChild).toHaveBeenCalledTimes(code === 0 ? 1 : 0);
    },
  );

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
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
      const includePatterns = [
        "ui/src/pages/chat/chat-pane-history.test.ts",
        "ui/src/pages/chat/chat-pane-retention.test.ts",
        "ui/src/pages/chat/chat-thread-retention.test.ts",
        "ui/src/pages/usage/usage-page-retention.test.ts",
      ];
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
        ...(policy === "dual" ? [{ runtime: "node", membership: undefined }] : []),
        { runtime: "bun", membership: includePatterns },
      ]);
    },
  );

  it.each([
    {
      policy: undefined,
      expected: [
        "eligible",
        "mixed",
        "unknown",
        "gateway-client",
        "memory",
        bunTarget,
        memoryTarget,
      ],
    },
    {
      policy: "bun-compatible",
      expected: [
        "bun:eligible",
        "mixed",
        "unknown",
        "bun:gateway-client",
        "bun:memory",
        `bun:${bunTarget}`,
        `bun:${memoryTarget}`,
      ],
    },
    {
      policy: "dual",
      expected: [
        "eligible",
        "bun:eligible",
        "mixed",
        "unknown",
        "gateway-client",
        "bun:gateway-client",
        "memory",
        "bun:memory",
        bunTarget,
        `bun:${bunTarget}`,
        memoryTarget,
        `bun:${memoryTarget}`,
      ],
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
        {
          configs: [gatewayClientConfig],
          shard_name: "gateway-client",
          includePatterns: [gatewayClientTarget],
        },
        {
          configs: [memoryConfig],
          shard_name: "memory",
          includePatterns: memoryIncludes,
          env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
        },
      ]),
    });
    const exitCode = await runShardPlans(
      [
        ...groups,
        { kind: "target", name: bunTarget, target: bunTarget },
        { kind: "target", name: memoryTarget, target: memoryTarget },
      ],
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
          if (label.endsWith("gateway-client")) {
            expect(JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8"))).toEqual([
              gatewayClientTarget,
            ]);
          }
          if (label.endsWith("memory")) {
            expect(JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8"))).toEqual(
              memoryIncludes,
            );
            expect(env.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
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
            : label.endsWith("gateway-client")
              ? [gatewayClientConfig]
              : label.endsWith("memory")
                ? [memoryConfig]
                : label.endsWith(memoryTarget)
                  ? [memoryTarget]
                  : [bunTarget];
      expect(args).toEqual([...targets, "--", "--maxWorkers=1"]);
    }
  });

  it.each(["node", "bun-compatible", "dual"] as const)(
    "preserves Gateway config coverage and execution budgets under %s",
    async (policy) => {
      const configs = [gatewayCoreConfig, gatewayClientConfig];
      const expected =
        policy === "node"
          ? [{ runtime: "node", configs, prefix: "" }]
          : [
              {
                runtime: "node",
                configs: policy === "dual" ? configs : [gatewayCoreConfig],
                prefix: policy === "dual" ? "" : "node-subset:",
              },
              { runtime: "bun", configs: [gatewayClientConfig], prefix: "bun:" },
            ];
      for (const includePatterns of [
        undefined,
        ["src/gateway/auth.test.ts", gatewayClientTarget],
      ]) {
        const group = {
          configs,
          includePatterns,
          shard_name: "gateway",
          timing_key: "gateway#include-original",
          env: { OPENCLAW_VITEST_MAX_WORKERS: "2", OWNER: "gateway" },
        };
        const persistentRoot = makeScratchDir();
        const seen: Array<{
          runtime: string | undefined;
          args: string[];
          label: string;
          timing: string;
        }> = [];
        let active = 0;
        let peakActive = 0;
        const jobEnv = { OPENCLAW_TEST_PROJECTS_PARALLEL: "2" };
        expect(ciTestShardRequiresBun({ env: jobEnv, groups: [group] }, policy)).toBe(
          policy !== "node",
        );
        await expect(
          runShardPlans(
            resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([group]) }),
            {
              concurrency: 1,
              env: {
                ...jobEnv,
                OPENCLAW_CI_TEST_RUNTIME_POLICY: policy,
                OPENCLAW_VITEST_MAX_WORKERS: "3",
                OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: persistentRoot,
                OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--hookTimeout=10000"]',
              },
              scratchDir: makeScratchDir(),
              runChild: async (args, env, label, timing) => {
                active += 1;
                peakActive = Math.max(peakActive, active);
                const runtime = env.OPENCLAW_VITEST_RUNTIME;
                seen.push({ runtime, args, label, timing });
                expect(env.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
                expect(env.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe("1");
                expect(env.OPENCLAW_VITEST_SHARD_NAME).toBe("gateway");
                expect(env.OWNER).toBe("gateway");
                expect(env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT).toBe(
                  path.join(
                    persistentRoot,
                    runtime === "bun" ? "vitest-cache-bun-0" : "vitest-cache-0",
                  ),
                );
                expect(
                  env.OPENCLAW_VITEST_INCLUDE_FILE
                    ? JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE, "utf8"))
                    : undefined,
                ).toEqual(includePatterns);
                await Promise.resolve();
                active -= 1;
                return 0;
              },
            },
          ),
        ).resolves.toBe(0);
        expect(peakActive).toBe(1);
        expect(seen).toEqual(
          expected.map(({ runtime, configs: selectedConfigs, prefix }) => ({
            runtime,
            args: [...selectedConfigs, "--", "--hookTimeout=10000"],
            label: `${prefix}gateway`,
            timing: `${prefix}gateway#include-original`,
          })),
        );
      }
    },
  );

  it("keeps an explicitly parallel Gateway pair on Node under both Bun policies", async () => {
    const configs = [gatewayCoreConfig, gatewayClientConfig];
    const group = {
      configs,
      shard_name: "gateway",
      env: { OPENCLAW_TEST_PROJECTS_PARALLEL: "2" },
    };
    for (const policy of ["bun-compatible", "dual"] as const) {
      const runChild = vi.fn(async () => 0);
      expect(ciTestShardRequiresBun({ groups: [group] }, policy)).toBe(false);
      await expect(
        runShardPlans(
          resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([group]) }),
          {
            env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
            scratchDir: makeScratchDir(),
            runChild,
          },
        ),
      ).resolves.toBe(0);
      expect(runChild).toHaveBeenCalledTimes(1);
      expect(runChild).toHaveBeenCalledWith(
        configs,
        expect.objectContaining({
          OPENCLAW_TEST_PROJECTS_PARALLEL: "2",
          OPENCLAW_VITEST_RUNTIME: "node",
        }),
        "gateway",
        "gateway",
      );
    }
  });

  it.each([
    { node: 7, bun: 0, native: 0, expected: 7 },
    { node: 0, bun: 9, native: 0, expected: 9 },
    { node: 7, bun: 9, native: 11, expected: 7 },
    { node: 0, bun: 0, native: 11, expected: 11 },
  ])("finishes every release engine and retains its first failure: %s", async (row) => {
    const runChild = vi.fn(async (args: string[], env: NodeJS.ProcessEnv) =>
      args[0] === "--native-bun"
        ? row.native
        : env.OPENCLAW_VITEST_RUNTIME === "bun"
          ? row.bun
          : row.node,
    );
    await expect(
      runShardPlans(
        resolveShardPlans({
          OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
            {
              configs: [bunConfig],
              shard_name: "eligible",
              includePatterns: [nodeTarget, vitestBunTarget, nativeBunTarget],
            },
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
      "bun",
    ]);
    expect(
      new Set(
        runChild.mock.calls.slice(0, 2).map(([, env]) => env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT),
      ).size,
    ).toBe(2);
    expect(runChild.mock.calls[2]?.[0]).toEqual(["--native-bun", `./${nativeBunTarget}`]);
    expect(runChild.mock.calls[2]?.[1].OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT).toBeUndefined();
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
      const pluginRetentionTest = "src/plugins/runtime.retention.test.ts";
      const nodeHistoryBenchmark = "test/scripts/bench-session-history.test.ts";
      const nativeCompilerTest = "test/scripts/native-typescript.test.ts";
      const compilerGraphTest = "test/scripts/ts-topology.test.ts";
      const mixedCompilerTest = "src/plugin-sdk/provider-tools.test.ts";
      const bunVitestFiles = [
        "src/agents/code-mode-node.test.ts",
        vitestBunTarget,
        nativeCompilerTest,
        compilerGraphTest,
        mixedCompilerTest,
        pluginRetentionTest,
        "src/process/spawn-broker/proxy-retention.test.ts",
        "src/auto-reply/reply/get-reply.imports.test.ts",
        "src/plugin-sdk/provider-catalog-shared.cancellation.test.ts",
        "src/plugin-sdk/provider-catalog-shared.retention.test.ts",
      ].toSorted();
      const nodeFiles = [
        skippedOnBun,
        v8HeapTest,
        nodeHistoryBenchmark,
        "packages/markdown-core/src/render-aware-chunking.test.ts",
      ];
      const nativeFiles = vitestArgs.length ? [] : [bunTarget, nativeBunTarget];
      const bunFiles = nativeFiles.length
        ? bunVitestFiles
        : [bunTarget, ...bunVitestFiles, nativeBunTarget].toSorted();
      const includePatterns = [bunTarget, ...bunVitestFiles, nativeBunTarget, ...nodeFiles];
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
              const native = label.startsWith("bun-native:");
              expect(args).toEqual(
                native
                  ? ["--native-bun", ...nativeFiles.map((file) => `./${file}`)]
                  : [bunConfig, ...(vitestArgs.length ? ["--", ...vitestArgs] : [])],
              );
              seen.push({
                runtime: env.OPENCLAW_VITEST_RUNTIME,
                includes: native
                  ? args.slice(1).map((file) => file.slice(2))
                  : JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8")),
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
        { runtime: "bun", includes: bunFiles, label: "bun:partition", timing: "bun:partition" },
        ...(nativeFiles.length
          ? [
              {
                runtime: "bun",
                includes: nativeFiles,
                label: "bun-native:partition",
                timing: "bun-native:partition",
              },
            ]
          : []),
      ]);
      expect(new Set(seen.flatMap(({ includes }) => includes))).toEqual(new Set(includePatterns));
    },
  );

  it.each(["bun-compatible", "dual"] as const)(
    "runs native Bun PTY coverage on Bun while retaining process siblings on Node under %s",
    async (policy) => {
      const bunFile = "src/process/terminal-pty-bun.test.ts";
      const nodeFile = "src/process/terminal-pty.test.ts";
      const seen: Array<{ runtime: string | undefined; includes: string[] }> = [];
      await expect(
        runShardPlans(
          [
            {
              kind: "group",
              name: "process",
              plan: {
                configs: ["test/vitest/vitest.process.config.ts"],
                includePatterns: [bunFile, nodeFile],
              },
            },
          ],
          {
            env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
            scratchDir: makeScratchDir(),
            runChild: async (_args, env) => {
              seen.push({
                runtime: env.OPENCLAW_VITEST_RUNTIME,
                includes: JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8")),
              });
              return 0;
            },
          },
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([
        { runtime: "node", includes: policy === "dual" ? [bunFile, nodeFile] : [nodeFile] },
        { runtime: "bun", includes: [bunFile] },
      ]);
      expect(resolveCiTestRuntimeSelections({ targets: [bunFile] }, policy)).toEqual(
        policy === "dual" ? [{ runtime: "node" }, { runtime: "bun" }] : [{ runtime: "bun" }],
      );
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
      { runtime: "bun", engine: "bun-test", files: [bunTarget] },
    ]);
    expect(
      resolveCiTestRuntimeSelections(
        { configs: [bunConfig], includePatterns: [nodeTarget] },
        "bun-compatible",
      ),
    ).toEqual([{ runtime: "node" }]);
    expect(
      resolveCiTestRuntimeSelections(
        {
          configs: [bunConfig],
          includePatterns: ["src/utils/{chunk-items,not-a-real-test}.test.ts"],
        },
        "bun-compatible",
      ),
    ).toEqual([{ runtime: "bun", engine: "bun-test", files: [nativeBunTarget] }]);
  });

  it("keeps exact native admission and Vitest-only arguments separate", () => {
    const selection = { targets: [nativeBunTarget] };
    expect(resolveCiTestRuntimeSelections(selection, "node")).toEqual([{ runtime: "node" }]);
    expect(resolveCiTestRuntimeSelections(selection, "dual")).toEqual([
      { runtime: "node" },
      { runtime: "bun", engine: "bun-test", files: [nativeBunTarget] },
    ]);
    expect(ciTestShardRequiresBun(selection, "bun-compatible")).toBe(true);
    for (const vitestArgs of [
      ["--testNamePattern=(?!)"],
      ["--maxWorkers=1"],
      ["--testTimeout=120000"],
      ["--hookTimeout=180000"],
      [`--exclude=${nativeBunTarget}`],
    ]) {
      expect(
        resolveCiTestRuntimeSelections({ ...selection, vitestArgs }, "bun-compatible"),
      ).toEqual([{ runtime: "bun" }]);
    }
    expect(
      resolveCiTestRuntimeSelections(
        {
          targets: [nativeBunTarget, vitestBunTarget],
        },
        "bun-compatible",
      ),
    ).toEqual([{ runtime: "bun" }]);
    expect(
      resolveCiTestRuntimeSelections(
        {
          configs: [bunConfig],
          includePatterns: ["src/infra/plain-object.test.ts"],
        },
        "bun-compatible",
      ),
    ).toEqual([{ runtime: "bun", includePatterns: ["src/infra/plain-object.test.ts"] }]);
  });

  it("keeps changed qualification inputs on Vitest without dropping their coverage", () => {
    const cwd = makeScratchDir();
    const { helperTest, helper, setup } = nativeQualificationFixtures;
    const files = [bunTarget, helperTest, nativeBunTarget];
    const copyInput = (file: string) => {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), readFileSync(file));
    };
    for (const file of [...Object.keys(nativeBunQualification.setup), helper, ...files]) {
      copyInput(file);
    }
    const selection = { configs: [bunConfig], includePatterns: files };
    expect(resolveCiTestRuntimeSelections(selection, "bun-compatible", cwd)).toEqual([
      { runtime: "bun", engine: "bun-test", files },
    ]);
    writeFileSync(path.join(cwd, "src/utils/chunk-items.ts"), "export const changed = true;\n");
    expect(resolveCiTestRuntimeSelections(selection, "bun-compatible", cwd)).toEqual([
      { runtime: "bun", engine: "bun-test", files },
    ]);
    writeFileSync(path.join(cwd, nativeBunTarget), `${readFileSync(nativeBunTarget, "utf8")}\n`);
    expect(resolveCiTestRuntimeSelections(selection, "dual", cwd)).toEqual([
      { runtime: "node" },
      { runtime: "bun", includePatterns: [nativeBunTarget] },
      { runtime: "bun", engine: "bun-test", files: [bunTarget, helperTest] },
    ]);
    writeFileSync(path.join(cwd, helper), "// changed fixture helper\n");
    expect(resolveCiTestRuntimeSelections(selection, "dual", cwd)).toEqual([
      { runtime: "node" },
      { runtime: "bun", includePatterns: [helperTest, nativeBunTarget] },
      { runtime: "bun", engine: "bun-test", files: [bunTarget] },
    ]);
    writeFileSync(path.join(cwd, setup), "// changed setup\n");
    expect(resolveCiTestRuntimeSelections(selection, "dual", cwd)).toEqual([
      { runtime: "node" },
      { runtime: "bun", includePatterns: files },
    ]);
  });

  it.each(["bun-compatible", "dual"] as const)(
    "admits the complete isolated inventory and its native compiler targets under %s",
    (policy) => {
      const config = "test/vitest/vitest.unit-fast-isolated.config.ts";
      const compilerFile = "src/agents/code-mode.auto-results.test.ts";
      for (const selection of [
        { configs: [config] },
        { targets: [compilerFile] },
        { configs: [config], includePatterns: [compilerFile] },
      ]) {
        expect(resolveCiTestRuntimeSelections(selection, policy)).toEqual(
          policy === "dual" ? [{ runtime: "node" }, { runtime: "bun" }] : [{ runtime: "bun" }],
        );
        expect(ciTestShardRequiresBun(selection, policy)).toBe(true);
      }
      const captureFile = "src/proxy-capture/proxy-server.test.ts";
      for (const captureSelection of [
        { targets: [captureFile] },
        { configs: ["test/vitest/vitest.infra.config.ts"], includePatterns: [captureFile] },
      ]) {
        expect(resolveCiTestRuntimeSelections(captureSelection, policy)).toEqual([
          { runtime: "node" },
        ]);
      }
      expect(resolveCiTestRuntimeSelections({ targets: ["src/version.test.ts"] }, policy)).toEqual(
        policy === "dual" ? [{ runtime: "node" }, { runtime: "bun" }] : [{ runtime: "bun" }],
      );
    },
  );

  it.each([
    {
      policy: "bun-compatible",
      config: unitConfig,
      nodeFile: "packages/acp-core/src/error-format.test.ts",
    },
    { policy: "dual", config: unitConfig, nodeFile: "packages/acp-core/src/error-format.test.ts" },
    { policy: "bun-compatible", config: unitSrcConfig, nodeFile: "src/audit/audit-config.test.ts" },
    { policy: "dual", config: unitSrcConfig, nodeFile: "src/audit/audit-config.test.ts" },
  ] as const)(
    "admits library coverage while preserving $config siblings under $policy",
    async ({ policy, config, nodeFile }) => {
      const includePatterns = [libraryTarget, nodeFile];
      const seen: Array<{ runtime: string | undefined; includes: string[] }> = [];
      await expect(
        runShardPlans(
          [{ kind: "group", name: "unit", plan: { configs: [config], includePatterns } }],
          {
            env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
            scratchDir: makeScratchDir(),
            runChild: async (_args, env) => {
              seen.push({
                runtime: env.OPENCLAW_VITEST_RUNTIME,
                includes: JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8")),
              });
              return 0;
            },
          },
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([
        { runtime: "node", includes: policy === "dual" ? includePatterns : [nodeFile] },
        { runtime: "bun", includes: [libraryTarget] },
      ]);
      expect(new Set(seen.flatMap(({ includes }) => includes))).toEqual(new Set(includePatterns));
      expect(resolveCiTestRuntimeSelections({ targets: [libraryTarget] }, policy)).toEqual(
        policy === "dual" ? [{ runtime: "node" }, { runtime: "bun" }] : [{ runtime: "bun" }],
      );
      expect(resolveCiTestRuntimeSelections({ targets: [nodeFile] }, policy)).toEqual([
        { runtime: "node" },
      ]);
      const full = resolveCiTestRuntimeSelections({ configs: [config] }, policy);
      expect(full).toEqual([
        policy === "dual"
          ? { runtime: "node" }
          : { runtime: "node", includePatterns: expect.arrayContaining([nodeFile]) },
        { runtime: "bun", includePatterns: [libraryTarget] },
      ]);
      if (policy === "bun-compatible") {
        expect(full[0]?.includePatterns).not.toContain(libraryTarget);
        expect(full[0]?.includePatterns).not.toContain(bunTarget);
        if (config === unitSrcConfig) {
          expect(full[0]?.includePatterns?.every((file) => file.startsWith("src/"))).toBe(true);
          expect(
            full[0]?.includePatterns?.some(
              (file) => file.startsWith("src/acp/") || file.startsWith("src/security/"),
            ),
          ).toBe(false);
        }
      }
      expect(ciTestShardRequiresBun({ configs: [config] }, policy)).toBe(true);
    },
  );

  it.each(["bun-compatible", "dual"] as const)(
    "admits transcript retention within its canonical embedded-run envelopes under %s",
    (policy) => {
      const sibling = "src/agents/embedded-agent-runner/run/abortable.test.ts";
      const includePatterns = [transcriptLifecycleTarget, sibling];
      const mixed = { configs: [embeddedRunConfig], includePatterns };
      expect(resolveCiTestRuntimeSelections(mixed, policy)).toEqual([
        policy === "dual" ? { runtime: "node" } : { runtime: "node", includePatterns: [sibling] },
        { runtime: "bun", includePatterns: [transcriptLifecycleTarget] },
      ]);
      expect(ciTestShardRequiresBun(mixed, policy)).toBe(true);
      expect(
        resolveCiTestRuntimeSelections(
          { configs: [embeddedRunConfig], includePatterns: [transcriptLifecycleTarget] },
          policy,
        ),
      ).toEqual([
        ...(policy === "dual" ? [{ runtime: "node" }] : []),
        { runtime: "bun", includePatterns: [transcriptLifecycleTarget] },
      ]);
      expect(
        resolveCiTestRuntimeSelections({ targets: [transcriptLifecycleTarget] }, policy),
      ).toEqual(
        policy === "dual" ? [{ runtime: "node" }, { runtime: "bun" }] : [{ runtime: "bun" }],
      );
      expect(resolveCiTestRuntimeSelections({ targets: [sibling] }, policy)).toEqual([
        { runtime: "node" },
      ]);
      const full = resolveCiTestRuntimeSelections({ configs: [embeddedRunConfig] }, policy);
      expect(full).toEqual([
        policy === "dual"
          ? { runtime: "node" }
          : { runtime: "node", includePatterns: expect.arrayContaining([sibling]) },
        { runtime: "bun", includePatterns: [transcriptLifecycleTarget] },
      ]);
      if (policy === "bun-compatible") {
        expect(full[0]?.includePatterns).not.toContain(transcriptLifecycleTarget);
        expect(full[0]?.includePatterns).not.toContain(
          "src/agents/embedded-agent-runner/run/attempt-transcript-lifecycle-prepare.test.ts",
        );
        expect(full[0]?.includePatterns).not.toContain(
          "src/agents/embedded-agent-runner/run/runtime-resolution.test.ts",
        );
      }
      expect(resolveCiTestRuntimeSelections(mixed, "node")).toEqual([{ runtime: "node" }]);
    },
  );

  it.each([
    { policy: "node", expected: [{ runtime: "node" }] },
    { policy: "bun-compatible", expected: [{ runtime: "bun" }] },
    { policy: "dual", expected: [{ runtime: "node" }, { runtime: "bun" }] },
  ] as const)("admits complete qualified worktree recovery selections under $policy", (row) => {
    for (const selection of [
      { targets: [worktreeRecoveryTarget] },
      { configs: [agentsSupportConfig], includePatterns: [worktreeRecoveryTarget] },
      {
        configs: [agentsSupportConfig],
        includePatterns: ["worktrees/service.removal-recovery.test.ts"],
      },
    ]) {
      expect(resolveCiTestRuntimeSelections(selection, row.policy)).toEqual(row.expected);
      expect(ciTestShardRequiresBun(selection, row.policy)).toBe(row.policy !== "node");
    }
  });

  it.each([
    { name: "full config", includePatterns: undefined, bun: true },
    { name: "empty group include list", includePatterns: [], bun: true },
    {
      name: "mixed exact files",
      includePatterns: [
        worktreeRecoveryTarget,
        "src/agents/worktrees/service.remove-lease.test.ts",
      ],
      bun: true,
    },
    {
      name: "repository-relative glob",
      includePatterns: ["src/agents/worktrees/service.*.test.ts"],
      bun: true,
    },
    { name: "scoped glob", includePatterns: ["worktrees/service.*.test.ts"], bun: true },
    {
      name: "unqualified sibling",
      includePatterns: ["src/agents/worktrees/service.remove-lease.test.ts"],
      bun: false,
    },
    {
      name: "external scoped include",
      includePatterns: ["src/channels/registry.test.ts"],
      bun: false,
    },
  ])("preserves agents-support envelopes and dual coverage for $name", (row) => {
    const selection = { configs: [agentsSupportConfig], includePatterns: row.includePatterns };
    expect(resolveCiTestRuntimeSelections(selection, "bun-compatible")).toEqual([
      { runtime: "node" },
    ]);
    expect(ciTestShardRequiresBun(selection, "bun-compatible")).toBe(false);
    expect(resolveCiTestRuntimeSelections(selection, "dual")).toEqual([
      { runtime: "node" },
      ...(row.bun ? [{ runtime: "bun", includePatterns: [worktreeRecoveryTarget] }] : []),
    ]);
    expect(ciTestShardRequiresBun(selection, "dual")).toBe(row.bun);
  });

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
    { env: { OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: "external.json" } },
    { configs: [bunConfig, "test/vitest/vitest.unit-fast-fake-timers.config.ts"] },
    { configs: [gatewayClientConfig, gatewayCoreConfig] },
    { configs: [gatewayCoreConfig, gatewayClientConfig, bunConfig] },
    { configs: [gatewayClientConfig, gatewayClientConfig] },
    { targets: [gatewayClientTarget] },
    { targets: ["packages/markdown-core/src"] },
    { targets: ["packages/markdown-core/src/*.test.ts"] },
    { targets: [bunTarget, nodeTarget] },
    {
      targets: [worktreeRecoveryTarget, "src/agents/worktrees/service.remove-lease.test.ts"],
    },
  ])("keeps ambiguous selection contracts on Node: %s", (selection) => {
    const shard = { configs: [bunConfig], ...selection };
    expect(resolveCiTestRuntimeSelections(shard, "bun-compatible")).toEqual([{ runtime: "node" }]);
    expect(resolveCiTestRuntimeSelections(shard, "dual")).toEqual([{ runtime: "node" }]);
    const qualifiedShard = {
      configs: [agentsSupportConfig],
      includePatterns: [worktreeRecoveryTarget],
      ...selection,
    };
    expect(resolveCiTestRuntimeSelections(qualifiedShard, "bun-compatible")).toEqual([
      { runtime: "node" },
    ]);
    expect(resolveCiTestRuntimeSelections(qualifiedShard, "dual")).toEqual([{ runtime: "node" }]);
    for (const configs of [
      [gatewayClientConfig],
      [gatewayCoreConfig, gatewayClientConfig],
      [unitConfig],
      [unitSrcConfig],
      ["test/vitest/vitest.unit-fast-isolated.config.ts"],
    ]) {
      const configSelection = { configs, ...selection };
      expect(resolveCiTestRuntimeSelections(configSelection, "bun-compatible")).toEqual([
        { runtime: "node" },
      ]);
      expect(resolveCiTestRuntimeSelections(configSelection, "dual")).toEqual([
        { runtime: "node" },
      ]);
    }
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
    "applies the UI runtime policy only to the Bun child under %s",
    async (policy) => {
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
      const seen: Array<Record<string, string | undefined>> = [];
      await expect(
        runShardPlans([{ kind: "group", name: "ui", plan: { configs: ["ui/vitest.config.ts"] } }], {
          env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
          scratchDir: makeScratchDir(),
          runChild: async (_args, env) => {
            if (policy === "dual") {
              expect(env.OPENCLAW_VITEST_NATIVE_SHARD_RECEIPT).toBeUndefined();
              if (env.OPENCLAW_VITEST_RUNTIME === "node") {
                expect(env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE).toBeUndefined();
              }
            }
            seen.push({
              runtime: env.OPENCLAW_VITEST_RUNTIME,
              warmup: env.BUN_JSC_thresholdForFTLOptimizeAfterWarmUp,
              soon: env.BUN_JSC_thresholdForFTLOptimizeSoon,
              ftlEnabled: env.BUN_JSC_useFTLJIT,
              allocatorInterval: env.MIMALLOC_PURGE_HOLES_MIN_INTERVAL,
            });
            return 0;
          },
        }),
      ).resolves.toBe(0);
      const expected = [
        {
          runtime: "node",
          warmup: undefined,
          soon: undefined,
          ftlEnabled: undefined,
          allocatorInterval: undefined,
        },
        {
          runtime: "bun",
          warmup: "512000",
          soon: "8000",
          ftlEnabled: undefined,
          allocatorInterval: "1000",
        },
      ];
      expect(seen).toEqual(policy === "dual" ? expected : expected.slice(1));
    },
  );

  it("runs qualified UI only on Bun without joined process ownership", async () => {
    vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(false);
    const seen: string[] = [];
    await expect(
      runShardPlans([{ kind: "group", name: "ui", plan: { configs: ["ui/vitest.config.ts"] } }], {
        env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-compatible" },
        scratchDir: makeScratchDir(),
        runChild: async (_args, env) => {
          seen.push(env.OPENCLAW_VITEST_RUNTIME!);
          expect(env.OPENCLAW_VITEST_NATIVE_SHARD_RECEIPT).toBeUndefined();
          return 0;
        },
      }),
    ).resolves.toBe(0);
    expect(seen).toEqual(["bun"]);
  });

  it.each([
    { receipt: "empty", bunCode: 0, expectedRuntimes: ["bun"] },
    { receipt: "node-member", bunCode: 0, expectedRuntimes: ["bun", "node"] },
    { receipt: "missing", bunCode: 0, expectedRuntimes: ["bun", "node"] },
    { receipt: "malformed", bunCode: 0, expectedRuntimes: ["bun", "node"] },
    { receipt: "stale", bunCode: 0, expectedRuntimes: ["bun", "node"] },
    { receipt: "wrong-config", bunCode: 0, expectedRuntimes: ["bun", "node"] },
    { receipt: "no-discovery", bunCode: 0, expectedRuntimes: ["bun", "node"] },
    { receipt: "unknown-file", bunCode: 0, expectedRuntimes: ["bun", "node"] },
    { receipt: "unsupported-version", bunCode: 0, expectedRuntimes: ["bun", "node"] },
    { receipt: "empty", bunCode: 17, expectedRuntimes: ["bun", "node"] },
  ])(
    "uses completed native UI membership ($receipt, Bun exit $bunCode) to admit Node",
    async ({ receipt, bunCode, expectedRuntimes }) => {
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
      const seen: string[] = [];
      let receiptFile: string | undefined;
      const nodeFile = "ui/src/synthetic-node-only.test.ts";
      const bunFile = "ui/src/pages/chat/chat-pane-history.test.ts";
      // All current UI files qualify for Bun; preserve the receipt transport's
      // fallback coverage with an explicit synthetic mixed-runtime partition.
      vi.spyOn(
        await import("../../scripts/lib/ci-test-runtime.mts"),
        "resolveCiTestRuntimeSelections",
      ).mockReturnValue([
        { runtime: "node", includePatterns: [nodeFile], includeAfterShard: true },
        { runtime: "bun", includePatterns: [bunFile], includeAfterShard: true },
      ]);
      await expect(
        runShardPlans([{ kind: "group", name: "ui", plan: { configs: ["ui/vitest.config.ts"] } }], {
          env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-compatible" },
          scratchDir: makeScratchDir(),
          runChild: async (_args, env) => {
            seen.push(env.OPENCLAW_VITEST_RUNTIME!);
            if (env.OPENCLAW_VITEST_RUNTIME === "node") {
              const included = JSON.parse(
                readFileSync(env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE!, "utf8"),
              );
              expect(included).toEqual([nodeFile]);
              return 0;
            }
            receiptFile = env.OPENCLAW_VITEST_NATIVE_SHARD_RECEIPT;
            expect(receiptFile).toBeTruthy();
            if (receipt !== "missing") {
              // Native producer equality is covered by the registered sequencer fixture;
              // this boundary exercises child-result transport and failed admission.
              const value = {
                version: receipt === "unsupported-version" ? 2 : 1,
                requestId:
                  receipt === "stale"
                    ? "previous-invocation"
                    : env.OPENCLAW_VITEST_NATIVE_SHARD_REQUEST_ID,
                config: path
                  .join(
                    process.cwd(),
                    receipt === "wrong-config" ? "vitest.config.ts" : "ui/vitest.config.ts",
                  )
                  .replaceAll("\\", "/"),
                root: path.join(process.cwd(), "ui").replaceAll("\\", "/"),
                files:
                  receipt === "no-discovery"
                    ? []
                    : receipt === "node-member"
                      ? [nodeFile, bunFile]
                      : receipt === "unknown-file"
                        ? ["ui/src/not-discovered.test.ts"]
                        : [bunFile],
              };
              writeFileSync(receiptFile!, receipt === "malformed" ? "{" : JSON.stringify(value));
            }
            return bunCode;
          },
        }),
      ).resolves.toBe(bunCode);
      expect(seen).toEqual(expectedRuntimes);
      expect(existsSync(receiptFile!)).toBe(false);
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
    { shard: { configs: [memoryConfig] }, expected: true },
    { shard: { targets: [memoryTarget] }, expected: true },
    { shard: { configs: [] }, expected: false },
    { shard: { configs: [bunConfig, "unknown.config.ts"] }, expected: false },
    {
      shard: { groups: [{ configs: [bunConfig] }, { configs: ["unknown.config.ts"] }] },
      expected: true,
    },
    { shard: { targets: [bunTarget] }, expected: true },
    { shard: { targets: [libraryTarget] }, expected: true },
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

  it.each([
    { name: "qualified bun-compatible Node", expected: "2" },
    { name: "explicit Node policy", policy: "node", expected: "2" },
    { name: "one CPU", cpus: 1, expected: "1" },
    { name: "physical memory", gib: 7.49, expected: "1" },
    { name: "cgroup memory", gib: 32, constrainedGiB: 7.49, expected: "1" },
    { name: "unlimited cgroup", constrainedGiB: 0, expected: "2" },
    { name: "nonfinite cgroup", constrainedGiB: Number.POSITIVE_INFINITY, expected: "2" },
    { name: "outer overlap", cpus: 8, gib: 24, outer: 2, expected: "1" },
    { name: "hosted runner", hosted: true, expected: "1" },
    { name: "frozen target", frozen: true, expected: "1" },
    { name: "unknown target", unknownTarget: true, expected: "1" },
    { name: "portable host", portable: true, expected: "1" },
    { name: "mixed config", mixed: true, expected: "1" },
    { name: "one file", singleton: true, expected: "1" },
    { name: "different config", otherConfig: true, expected: "1" },
    { name: "runtime build", runtime: true, expected: "1" },
    { name: "runtime consumer", runtimeConsumer: true, expected: "1" },
    { name: "dist build", dist: true, expected: "1" },
    { name: "one worker", workers: "1", expected: "1" },
    { name: "caller cache", callerLeaf: true, expected: "1" },
  ])("admits inner singleton overlap from actual $name facts", async (scenario) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(scenario.portable ? "darwin" : "linux");
    vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
    vi.spyOn(os, "availableParallelism").mockReturnValue(scenario.cpus ?? 2);
    vi.spyOn(os, "totalmem").mockReturnValue((scenario.gib ?? 7.65) * 1024 ** 3);
    vi.spyOn(process, "constrainedMemory").mockReturnValue(
      (scenario.constrainedGiB ?? 7.65) * 1024 ** 3,
    );
    const scratchDir = makeScratchDir();
    const files = [
      "extensions/telegram/src/telegram-ingress-spool.test.ts",
      "extensions/telegram/src/webhook.test.ts",
    ];
    const includes = scenario.singleton
      ? files.slice(0, 1)
      : scenario.mixed
        ? [files[0]!, memoryTarget]
        : scenario.runtimeConsumer
          ? ["extensions/telegram/src/bot.create-telegram-bot.native-pipeline.test.ts", files[1]!]
          : files;
    const groups = Array.from({ length: scenario.outer ?? 1 }, (_, index) => ({
      configs: [
        scenario.otherConfig
          ? "test/vitest/vitest.extension-telegram.config.ts"
          : "test/vitest/vitest.extension-database-workers.config.ts",
      ],
      shard_name: `changed-extensions-config-${index + 1}`,
      includePatterns: includes,
      requiresDist: scenario.dist ?? false,
      ...(scenario.runtime ? { pretestBuildMode: "runtime" } : {}),
      env: {
        OPENCLAW_VITEST_MAX_WORKERS: scenario.workers ?? "2",
        OPENCLAW_TEST_PROJECTS_PARALLEL: "2",
      },
    }));
    const runtimes: Array<string | undefined> = [];
    const runChild = vi.fn(async (_args, env) => {
      runtimes.push(env.OPENCLAW_VITEST_RUNTIME);
      expect(env.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe(scenario.expected);
      expect(env.OPENCLAW_VITEST_MAX_WORKERS).toBe(scenario.workers ?? "2");
      expect(JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE, "utf8"))).toEqual(includes);
      return 0;
    });
    await expect(
      runShardPlans(resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(groups) }), {
        concurrency: scenario.outer ?? 1,
        env: {
          CI: "1",
          RUNNER_ENVIRONMENT: scenario.hosted ? "github-hosted" : "self-hosted",
          FROZEN_TARGET: scenario.unknownTarget ? undefined : scenario.frozen ? "true" : "false",
          OPENCLAW_CI_TEST_RUNTIME_POLICY: scenario.policy ?? "bun-compatible",
          ...(scenario.callerLeaf
            ? {
                OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: scratchDir,
                OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(scratchDir, "caller"),
              }
            : {}),
        },
        scratchDir,
        runChild,
      }),
    ).resolves.toBe(0);
    expect(runChild).toHaveBeenCalledTimes(groups.length);
    expect(runtimes).toEqual(groups.map(() => "node"));
  });

  it.each([false, true])(
    "shares one compiler across admitted mixed scheduling groups (serial first=%s)",
    async (serialFirst) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
      vi.spyOn(os, "availableParallelism").mockReturnValue(2);
      vi.spyOn(os, "totalmem").mockReturnValue(8 * 1024 ** 3);
      vi.spyOn(process, "constrainedMemory").mockReturnValue(8 * 1024 ** 3);
      const createWorker = vi.spyOn(workerOwner, "createVitestWorkerRun");
      const groups = [
        {
          configs: ["test/vitest/vitest.extension-database-workers.config.ts"],
          shard_name: "changed-extensions-config-54",
          includePatterns: [
            "extensions/telegram/src/telegram-ingress-spool.test.ts",
            "extensions/telegram/src/webhook.test.ts",
          ],
          env: { OPENCLAW_VITEST_MAX_WORKERS: "2", OPENCLAW_TEST_PROJECTS_PARALLEL: "2" },
        },
        {
          configs: ["test/vitest/vitest.extension-imessage.config.ts"],
          shard_name: "changed-extensions-config-13",
          includePatterns: ["extensions/imessage/src/conversation-route.test.ts"],
          env: { OPENCLAW_VITEST_MAX_WORKERS: "1" },
        },
      ];
      if (serialFirst) {
        groups.reverse();
      }
      const runChild = vi.fn(async (_args: string[], env: NodeJS.ProcessEnv, label: string) => {
        const group = groups.find((candidate) => candidate.shard_name === label)!;
        expect(env.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe(
          group.env.OPENCLAW_TEST_PROJECTS_PARALLEL ?? "1",
        );
        expect(env.OPENCLAW_VITEST_MAX_WORKERS).toBe(group.env.OPENCLAW_VITEST_MAX_WORKERS);
        expect(JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE!, "utf8"))).toEqual(
          group.includePatterns,
        );
        return 0;
      });
      await expect(
        runShardPlans(
          resolveShardPlans({
            OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups(groups),
          }),
          {
            concurrency: 1,
            env: {
              CI: "1",
              RUNNER_ENVIRONMENT: "self-hosted",
              FROZEN_TARGET: "false",
              OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-compatible",
              OPENCLAW_VITEST_MAX_WORKERS: "2",
            },
            scratchDir: makeScratchDir(),
            runChild,
          },
        ),
      ).resolves.toBe(0);
      expect(runChild.mock.calls.map((call) => call[2])).toEqual(
        groups.map((group) => group.shard_name),
      );
      expect(createWorker).toHaveBeenCalledExactlyOnceWith({
        CI: "1",
        RUNNER_ENVIRONMENT: "self-hosted",
        FROZEN_TARGET: "false",
        OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-compatible",
        RAYON_NUM_THREADS: "1",
        TOKIO_WORKER_THREADS: "1",
      });
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
      if (shared) {
        vi.spyOn(os, "tmpdir").mockReturnValue(scratchDir);
      }
      const runChild = vi.fn(async (_args: string[], _env: NodeJS.ProcessEnv) => 0);
      const plans = resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
          { configs: ["one.config.ts"], includePatterns: ["src/one.test.ts"] },
          { configs: ["two.config.ts"], env: { [key]: "different-loader" } },
        ]),
      });
      const pending = runShardPlans(plans, {
        env: {},
        scratchDir: shared ? undefined : scratchDir,
        runChild,
      });
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

  it.each([
    gatewayCoreConfig,
    "vitest.config.ts",
    "test/vitest/vitest.config.ts",
    "test/vitest/vitest.full-agentic.config.ts",
    "test/vitest/vitest.gateway.config.ts",
  ])(
    "joins ordinary spans around %s with stable cache lanes and include indices",
    async (exclusiveConfig) => {
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
      vi.spyOn(os, "availableParallelism").mockReturnValue(8);
      vi.spyOn(os, "totalmem").mockReturnValue(24 * 1024 ** 3);
      const gates = Array.from({ length: 5 }, () => createDeferred<number>());
      const admissions = gates.map(() => createDeferred());
      const seen: Array<{
        label: string;
        cache: string;
        include: string;
        workers: string | undefined;
      }> = [];
      const configs = ["a.config.ts", "b.config.ts", exclusiveConfig, "c.config.ts", "d.config.ts"];
      const scratchDir = makeScratchDir();
      const pending = runShardPlans(
        resolveShardPlans({
          OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
            configs.map((config, index) => ({
              configs: [config],
              shard_name: String(index),
              includePatterns: [`src/${index}.test.ts`],
              fallbackMaxWorkers: 2,
              env: { OPENCLAW_VITEST_MAX_WORKERS: "8" },
            })),
          ),
        }),
        {
          env: {
            CI: "1",
            RUNNER_ENVIRONMENT: "self-hosted",
            OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: scratchDir,
          },
          scratchDir,
          runChild: async (_args, env, label) => {
            seen.push({
              label,
              cache: env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT!,
              include: env.OPENCLAW_VITEST_INCLUDE_FILE!,
              workers: env.OPENCLAW_VITEST_MAX_WORKERS,
            });
            admissions[Number(label)]!.resolve();
            return gates[Number(label)]!.promise;
          },
        },
      );
      try {
        await withTestTimeout(
          Promise.race([
            Promise.all(admissions.slice(0, 2).map((admission) => admission.promise)),
            pending,
          ]),
          1_000,
          "ordinary span admission",
        );
        expect(seen).toHaveLength(2);
        gates[0]!.resolve(0);
        await nextTurn();
        expect(seen).toHaveLength(2);
        gates[1]!.resolve(0);
        await withTestTimeout(
          Promise.race([admissions[2]!.promise, pending]),
          1_000,
          "exclusive plan admission",
        );
        expect(seen).toHaveLength(3);
        expect(seen[2]!.workers).toBe("8");
        gates[2]!.resolve(0);
        await withTestTimeout(
          Promise.race([
            Promise.all(admissions.slice(3).map((admission) => admission.promise)),
            pending,
          ]),
          1_000,
          "post-barrier span admission",
        );
        expect(seen).toHaveLength(5);
        expect(seen.map(({ label }) => label)).toEqual(["0", "1", "2", "3", "4"]);
        expect(seen.map(({ cache }) => path.basename(cache))).toEqual([
          "vitest-cache-0",
          "vitest-cache-1",
          "vitest-cache-0",
          "vitest-cache-0",
          "vitest-cache-1",
        ]);
        expect(seen.map(({ include }) => path.basename(include))).toEqual(
          configs.map((_, index) => `node-test-include-${index}.json`),
        );
        expect(seen.map(({ include }) => JSON.parse(readFileSync(include, "utf8")))).toEqual(
          configs.map((_, index) => [`src/${index}.test.ts`]),
        );
        expect(seen.filter(({ label }) => label !== "2").map(({ workers }) => workers)).toEqual([
          "2",
          "2",
          "2",
          "2",
        ]);
      } finally {
        gates.forEach((gate) => gate.resolve(0));
        await expect(pending).resolves.toBe(0);
      }
    },
  );

  it.each([
    { portable: true, exclusive: true, callerLeaf: "none", expected: 1 },
    { portable: true, exclusive: false, callerLeaf: "none", expected: 2 },
    { portable: false, exclusive: true, callerLeaf: "base", expected: 1 },
    { portable: false, exclusive: true, callerLeaf: "group", expected: 1 },
    { portable: false, exclusive: false, callerLeaf: "base", expected: 1 },
    { portable: false, exclusive: true, callerLeaf: "none", expected: 2 },
  ])(
    "retains portable/cache ownership admission and worker sizing $portable/$exclusive/$callerLeaf",
    async ({ portable, exclusive, callerLeaf, expected }) => {
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(!portable);
      vi.spyOn(os, "availableParallelism").mockReturnValue(8);
      vi.spyOn(os, "totalmem").mockReturnValue(31 * 1024 ** 3);
      const createWorker = vi.spyOn(workerOwner, "createVitestWorkerRun");
      const scratchDir = makeScratchDir();
      let active = 0;
      let peak = 0;
      const workers: Array<string | undefined> = [];
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await expect(
        runShardPlans(
          resolveShardPlans({
            OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
              [exclusive ? gatewayCoreConfig : "a.config.ts", "b.config.ts", "c.config.ts"].map(
                (config) => ({
                  configs: [config],
                  fallbackMaxWorkers: 2,
                  env:
                    callerLeaf === "group"
                      ? { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(scratchDir, "caller") }
                      : undefined,
                }),
              ),
            ),
          }),
          {
            env: {
              CI: "true",
              RUNNER_ENVIRONMENT: "self-hosted",
              OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "2",
              OPENCLAW_VITEST_MAX_WORKERS: "8",
              ...(callerLeaf === "base"
                ? {
                    OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: scratchDir,
                    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(scratchDir, "caller"),
                  }
                : {}),
            },
            scratchDir,
            runChild: async (_args, env) => {
              workers.push(env.OPENCLAW_VITEST_MAX_WORKERS);
              active += 1;
              peak = Math.max(peak, active);
              await nextTurn();
              active -= 1;
              return 0;
            },
          },
        ),
      ).resolves.toBe(0);
      expect(peak).toBe(expected);
      expect(active).toBe(0);
      expect(workers).toEqual(expected === 1 ? ["8", "8", "8"] : [exclusive ? "8" : "2", "2", "2"]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`admitted plans=${expected}`));
      expect(createWorker).toHaveBeenCalledTimes(portable ? 0 : 1);
      if (!portable) {
        expect(createWorker.mock.calls[0]?.[0]).toMatchObject({
          RAYON_NUM_THREADS: expected === 1 ? "4" : "2",
          TOKIO_WORKER_THREADS: expected === 1 ? "4" : "2",
        });
        const run = createWorker.mock.results[0]!.value;
        expect(existsSync(run.descriptor.directory)).toBe(false);
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
    ["numeric CI boolean", 8, 24, "1", undefined, 2, 2, undefined],
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
        [name, 8, 24, "true", undefined, 2, 2, `test/vitest/vitest.${name}.config.ts`] as const,
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
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
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

  it("keeps native Bun, Bun Vitest and Node membership timing spans separate", async () => {
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
          const seconds = spanKey.startsWith("bun-native:")
            ? "02"
            : spanKey.startsWith("bun:")
              ? "03"
              : "10";
          lines.push(`2026-08-27T23:00:${seconds}Z [shard:${spanKey}] end (exit 0)`);
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
    expect(
      refitTestTimings(runs).timings.compactGroupSeconds.blacksmith[`bun-native:${timingKey}`],
    ).toBe(2);
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
    "retires generated scratch only after admitted plans settle on a %s failure",
    async (failure) => {
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
      const started: string[] = [];
      const ownedScratch = new Set<string>();
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
          runChild: (_args, _env, label) => {
            const cache = _env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT!;
            const scratch = path.dirname(cache);
            ownedScratch.add(scratch);
            scratchDirs.push(scratch);
            mkdirSync(cache);
            writeFileSync(path.join(cache, "transform"), "cached");
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
        expect([...ownedScratch].every(existsSync)).toBe(true);
      } finally {
        held.resolve();
        await nextTurn();
        await Promise.allSettled(children);
        await pending;
      }
      const outcome = await pending;
      if (failure === "rejection") {
        expect(outcome.error).toBeInstanceOf(AggregateError);
        const failures = (outcome.error as AggregateError).errors;
        expect(failures).toHaveLength(1);
        expect(failures[0]).toBe(error);
      } else {
        expect(outcome.exitCode).toBe(7);
      }
      expect(started).toEqual(["a", "b"]);
      expect([...ownedScratch].some(existsSync)).toBe(false);
    },
  );

  it.each([0, 7])("preserves shard exit %i when scratch removal fails", async (exitCode) => {
    vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fsPromises, "rm").mockRejectedValue(new Error("scratch removal denied"));
    let scratch = "";
    await expect(
      runShardPlans([{ kind: "target", name: "one", target: "one.test.ts" }], {
        env: {},
        runChild: async (_args, env) => {
          scratch = path.dirname(env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT!);
          scratchDirs.push(scratch);
          return exitCode;
        },
      }),
    ).resolves.toBe(exitCode);
    expect(existsSync(scratch)).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`retained ${scratch}`));
  });

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
    { name: "success", code: 0, signal: null, complete: true },
    { name: "ordinary failure", code: 7, signal: null, complete: true },
    { name: "early stop", code: 7, signal: null, stop: true },
    { name: "killed child", code: null, signal: "SIGKILL" },
    { name: "unknown exit", code: null, signal: null },
    { name: "unjoined child", code: 1, signal: null, unjoined: true, rejects: true },
    { name: "scratch cleanup failure", code: 0, signal: null, scratchFailure: true },
    { name: "owner cleanup failure", code: 0, signal: null, ownerFailure: true, rejects: true },
  ] as const)("publishes a completion receipt only for verified $name", async (scenario) => {
    vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
    const processOwner = await import("../../scripts/lib/vitest-process.mts");
    const createWorker = workerOwner.createVitestWorkerRun;
    const directories: string[] = [];
    vi.spyOn(workerOwner, "createVitestWorkerRun").mockImplementation((...args) => {
      const worker = createWorker(...args);
      directories.push(worker.descriptor.directory);
      scratchDirs.push(worker.descriptor.directory);
      if ("ownerFailure" in scenario) {
        const dispose = worker.dispose.bind(worker);
        vi.spyOn(worker, "dispose").mockImplementation(async () => {
          await dispose();
          throw new Error("owner cleanup failed");
        });
      }
      return worker;
    });
    if ("scratchFailure" in scenario) {
      vi.spyOn(fsPromises, "rm").mockRejectedValue(new Error("scratch cleanup failed"));
    }
    let invocations = 0;
    const spawn = vi.spyOn(processOwner, "spawnOwnedVitestProcess").mockImplementation((spec) => {
      const child = new childProcess.ChildProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const scratch = path.dirname(spec.options.env!.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT!);
      if (!scratchDirs.includes(scratch)) {
        scratchDirs.push(scratch);
      }
      const first = invocations++ === 0;
      const outcome = {
        code: first ? scenario.code : 0,
        signal: first ? scenario.signal : null,
        groupJoined: !("unjoined" in scenario),
      };
      const completion = new Promise<typeof outcome>((resolve) => {
        queueMicrotask(() => {
          child.emit("close", outcome.code, outcome.signal);
          resolve(outcome);
        });
      });
      return { child, completion };
    });
    const receipts: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (String(chunk).startsWith("[shard:completion] ")) {
        expect(directories.some(existsSync)).toBe(false);
        receipts.push(String(chunk));
      }
      return true;
    });
    const pending = runShardPlans(
      ["one", "two"].map((name) => ({ kind: "target" as const, name, target: `${name}.test.ts` })),
      { concurrency: 1, continueOnFailure: !("stop" in scenario), env: {} },
    );
    if ("rejects" in scenario) {
      await expect(pending).rejects.toThrow();
    } else {
      await expect(pending).resolves.toBe(scenario.code ?? 1);
    }
    expect(spawn).toHaveBeenCalledTimes("stop" in scenario || "unjoined" in scenario ? 1 : 2);
    expect(receipts).toEqual(
      "complete" in scenario
        ? [
            `[shard:completion] {"version":1,"planned":2,"completed":2,"invocations":2,"failedInvocations":${scenario.code === 0 ? 0 : 1}}\n`,
          ]
        : [],
    );
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
