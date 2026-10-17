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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { collectVitestFileFilters } from "../../scripts/lib/vitest-cli-mode.mts";
import { resolveLocalVitestScheduling } from "../../scripts/lib/vitest-local-scheduling.mts";
import * as workerOwner from "../../scripts/lib/vitest-worker-run.mts";
import { createVitestRunSpecs } from "../../scripts/test-projects.test-support.mts";
import * as groupOwner from "../../scripts/vitest-process-group.mts";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

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
const graphemeTarget = "packages/normalization-core/src/grapheme.test.ts";
const libraryTarget = "src/library.test.ts";
const workerQuiescenceTarget = "src/node-host/node-worker-workspace-quiescence.acceptance.test.ts";
const workerClosingWindowTarget = "src/worker/worker-connection-closing-window.test.ts";
const bunTarget = nativeQualificationFixtures.first;
const vitestBunTarget = "src/agents/sandbox/docker.execDockerRaw.enoent.test.ts";
const nativeBunTarget = nativeQualificationFixtures.second;
const nodeTarget = "src/cli/cli-process-diagnostics.test.ts";
const agentsSupportConfig = "test/vitest/vitest.agents-support.config.ts";
const worktreeRecoveryTarget = "src/agents/worktrees/service.removal-recovery.test.ts";
const gatewayCoreConfig = "test/vitest/vitest.gateway-core.config.ts";
const gatewayClientConfig = "test/vitest/vitest.gateway-client.config.ts";
const gatewayClientTarget = "src/gateway/talk/handlers/client-native-control.test.ts";
const gatewayWorkspaceHashTarget = "src/gateway/worker-environments/workspace-hash-memo.test.ts";
const memoryConfig = "test/vitest/vitest.extension-memory.config.ts";
const memoryTarget = "extensions/memory-lancedb/config.test.ts";
const memoryIncludes = ["extensions/memory-lancedb", "extensions/memory-wiki"];

function makeScratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-shard-test-"));
  scratchDirs.push(dir);
  return dir;
}

beforeEach(() => {
  const env = testRunnerFixtureEnv();
  for (const name of ["CI", "GITHUB_ACTIONS", "OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE"]) {
    vi.stubEnv(name, env[name]);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("scripts/ci-run-node-test-shard.mts", () => {
  it.each([
    { flags: ["--root", "alternate"] },
    { flags: ["-r", "alternate"] },
    { flags: ["-r=alternate"] },
    { flags: ["--reporter=json"] },
    { flags: ["--reporter", "blob"] },
    { flags: ["--reporters", "junit"] },
    { flags: ["--listTags"] },
    { flags: ["--clearCache"] },
    { flags: ["--standalone"] },
    { flags: ["--help"] },
    { flags: ["-h"] },
    { flags: ["--version"] },
    { flags: ["-v"] },
  ])("preserves the native Gateway invocation for $flags", ({ flags }) => {
    const config = "test/vitest/vitest.gateway-server.config.ts";
    const specs = createVitestRunSpecs([config, "--", ...flags], { baseEnv: {} });
    expect(specs.map((spec) => spec.pnpmArgs.slice(spec.pnpmArgs.indexOf("--config")))).toEqual([
      ["--config", config, ...flags],
    ]);
  });

  it("preserves line-qualified Gateway selections without widening them to entire files", () => {
    const cwd = makeScratchDir();
    mkdirSync(path.join(cwd, "src/gateway"), { recursive: true });
    const filters = Array.from({ length: 17 }, (_, index) => {
      const file = `src/gateway/server.line-${index}.test.ts`;
      writeFileSync(path.join(cwd, file), "");
      return `${file}:3`;
    });
    const config = "test/vitest/vitest.gateway-server.config.ts";
    const specs = createVitestRunSpecs([config, "--", ...filters], { cwd, baseEnv: {} });
    expect(specs.map((spec) => spec.pnpmArgs.slice(spec.pnpmArgs.indexOf("--config")))).toEqual([
      ["--config", config, ...filters],
    ]);
  });

  it.each([{ filters: [] }, { filters: ["server.chat-fixture"] }])(
    "bounds the CI Gateway include selection with filters $filters inside its original timing envelope",
    async ({ filters }) => {
      const cwd = makeScratchDir();
      mkdirSync(path.join(cwd, "src/gateway"), { recursive: true });
      const files = Array.from(
        { length: 74 },
        (_, index) => `src/gateway/server.chat-fixture-${String(index).padStart(3, "0")}.test.ts`,
      );
      for (const file of files.filter((_, index) => index !== 72)) {
        writeFileSync(path.join(cwd, file), "");
      }
      expect(childProcess.spawnSync("git", ["init", "--quiet"], { cwd }).status).toBe(0);
      expect(childProcess.spawnSync("git", ["add", "."], { cwd }).status).toBe(0);
      // Native discovery includes a newly written test before it is staged.
      writeFileSync(path.join(cwd, files[72]!), "");
      const included = files.slice(0, 73);
      const config = "test/vitest/vitest.gateway-server.config.ts";
      const launched: string[][] = [];
      const envelopes: string[] = [];
      const code = await runShardPlans(
        [
          {
            kind: "group",
            name: "agent-chat",
            timingKey: "original-key",
            plan: { configs: [config], includePatterns: included },
          },
        ],
        {
          env: { CI: "1", OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(filters) },
          scratchDir: cwd,
          runChild: async (args, env, _label, timingKey) => {
            envelopes.push(timingKey);
            const specs = createVitestRunSpecs(args, { baseEnv: env, cwd });
            for (const spec of specs) {
              const cliFilters = collectVitestFileFilters(
                spec.pnpmArgs.slice(spec.pnpmArgs.indexOf("run")),
              );
              launched.push(
                files.filter((file) => cliFilters.some((filter) => file.includes(filter))),
              );
              expect(spec.env.OPENCLAW_VITEST_INCLUDE_FILE).toBe(env.OPENCLAW_VITEST_INCLUDE_FILE);
            }
            return 1;
          },
        },
      );
      expect(code).toBe(1);
      expect(envelopes).toEqual(["original-key"]);
      expect(launched.map((chunk) => chunk.length)).toEqual([15, 15, 15, 14, 14]);
      expect(launched.flat()).toEqual(included);
    },
  );

  it.each([
    { preparation: "UI", code: 0 },
    { preparation: "UI", code: 23 },
    { preparation: "package", code: 0 },
    { preparation: "package", code: 23 },
  ])(
    "settles $preparation preparation before prebuilt readers (exit $code)",
    async ({ preparation, code }) => {
      const ui = preparation === "UI";
      vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(false);
      const started = createDeferred();
      const prepared = createDeferred<number>();
      const prepare = vi
        .spyOn(buildPrerequisites, ui ? "prepareVitestControlUi" : "preparePrebuiltAiPackage")
        .mockImplementation(async () => {
          started.resolve();
          return prepared.promise;
        });
      const target = ui
        ? "test/e2e/line-doctor-group-allowlist.built-cli.e2e.test.ts"
        : "packages/ai/src/package.e2e.test.ts";
      const runChild = vi.fn().mockResolvedValue(0);
      const pending = runShardPlans(
        [
          { kind: "target", name: ui ? "LINE" : "AI package", target },
          ...(ui
            ? [
                {
                  kind: "group" as const,
                  name: "Doctor",
                  plan: {
                    configs: ["test/vitest/vitest.e2e.config.ts"],
                    includePatterns: [
                      "test/e2e/qa-lab/runtime/doctor-auth-secretref-checks.e2e.test.ts",
                    ],
                  },
                },
                {
                  kind: "group" as const,
                  name: "Explicit skip",
                  plan: {
                    configs: ["test/vitest/vitest.e2e.config.ts"],
                    env: { OPENCLAW_E2E_SKIP_BUILD: "1" },
                  },
                },
              ]
            : []),
        ],
        {
          env: { OPENCLAW_E2E_USE_PREBUILT_DIST: "1" },
          scratchDir: makeScratchDir(),
          runChild,
        },
      );
      await started.promise;
      expect(runChild).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledOnce();
      if (ui) {
        expect(prepare.mock.calls[0]?.[0]).toEqual([
          expect.objectContaining({ includePatterns: [target] }),
          expect.objectContaining({
            configs: ["test/vitest/vitest.e2e.config.ts"],
            includePatterns: ["test/e2e/qa-lab/runtime/doctor-auth-secretref-checks.e2e.test.ts"],
          }),
        ]);
      }
      prepared.resolve(code);
      expect(await pending).toBe(code);
      expect(runChild).toHaveBeenCalledTimes(code === 0 ? (ui ? 3 : 1) : 0);
    },
  );

  it("does not prepare UI for an excluded Doctor target", async () => {
    const target = "test/e2e/line-doctor-group-allowlist.built-cli.e2e.test.ts";
    const prepare = vi.spyOn(buildPrerequisites, "prepareVitestControlUi");
    const runChild = vi.fn().mockResolvedValue(0);
    expect(
      await runShardPlans([{ kind: "target", name: "LINE", target }], {
        env: {
          OPENCLAW_E2E_USE_PREBUILT_DIST: "1",
          OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--exclude", target]),
        },
        scratchDir: makeScratchDir(),
        runChild,
      }),
    ).toBe(0);
    expect(prepare).toHaveResolvedWith(0);
    const selection = prepare.mock.calls[0]![0][0]!;
    expect(selection.matchesFile?.(target, true, selection.includePatterns)).toBe(false);
  });

  it("preserves workflow commands at column zero while labeling child stdout", async () => {
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
    streams.stdout.emit("data", bytes.subarray(0, 20));
    streams.stdout.emit("data", bytes.subarray(20));
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
        "[shard-failure:compact] FAILED (exit 1)",
        ...lines.map((line) => `[shard-failure:compact:tail] ${line}`),
        "",
      ].join("\n"),
    );
  });

  it.each([
    { code: 7, signal: null, exit: 7 },
    { code: null, signal: "SIGTERM", exit: 143 },
    { code: 0, signal: null, exit: 0 },
  ] as const)("keeps invocation diagnostics searchable after exit $exit", async (outcome) => {
    vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(false);
    const child = new childProcess.ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
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
    child.stdout.emit("data", `${"old output".repeat(3_000)}\n`);
    child.stdout.emit("data", "binary\0output\n");
    child.stderr.emit("data", "::error::root failure\nunterminated diagnostic");
    child.emit("close", outcome.code, outcome.signal);
    await expect(pending).resolves.toBe(outcome.exit);

    const log = output.join("");
    expect(log).not.toContain("\0");
    expect(log).toContain("binary\\0output");
    const summary = log.slice(log.indexOf(`[shard:compact] end (exit ${outcome.exit})`));
    if (outcome.exit === 0) {
      expect(summary).not.toContain("FAILED");
      expect(summary).not.toContain("[shard-failure:compact:tail]");
    } else {
      expect(summary).toContain(
        `[shard-failure:compact] FAILED (exit ${outcome.exit}${outcome.signal ? `, signal ${outcome.signal}` : ""})`,
      );
      expect(summary).toContain("[shard-failure:compact:tail] ::error::root failure");
      expect(summary).toContain("[shard-failure:compact:tail] unterminated diagnostic");
      expect(summary.length).toBeLessThan(17_000);
      expect(summary).not.toContain("old output".repeat(3_000));
    }
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

  it("preserves selected UI discovery before runtime partitioning under bun-compatible", async () => {
    vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
    const includePatterns = [
      "ui/src/pages/chat/chat-pane-history.test.ts",
      "ui/src/pages/chat/chat-thread-retention.test.ts",
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
            OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-compatible",
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
    expect(seen).toEqual([{ runtime: "bun", membership: includePatterns }]);
  });

  it("preserves complete process envelopes under bun-compatible", async () => {
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
          OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-compatible",
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
    expect(seen.map(({ label }) => label)).toEqual([
      "bun:eligible",
      "mixed",
      "unknown",
      "bun:gateway-client",
      "bun:memory",
      `bun:${bunTarget}`,
      `bun:${memoryTarget}`,
    ]);
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

  it.each(["bun-compatible", "dual"] as const)(
    "preserves Gateway config coverage and execution budgets under %s",
    async (policy) => {
      const configs = [gatewayCoreConfig, gatewayClientConfig];
      for (const includePatterns of [
        undefined,
        ["src/gateway/auth.test.ts", gatewayClientTarget],
        [gatewayClientTarget],
        [gatewayWorkspaceHashTarget],
        [gatewayWorkspaceHashTarget, gatewayClientTarget],
        [gatewayWorkspaceHashTarget, "src/gateway/auth.test.ts", gatewayClientTarget],
      ]) {
        const qualifiedCore =
          includePatterns?.length === 1 && includePatterns[0] === gatewayWorkspaceHashTarget;
        const selectedCore =
          !includePatterns || includePatterns.includes(gatewayWorkspaceHashTarget);
        const expected = [
          ...(policy === "dual"
            ? [{ runtime: "node", configs, prefix: "", includePatterns }]
            : qualifiedCore
              ? []
              : [
                  {
                    runtime: "node",
                    configs: [gatewayCoreConfig],
                    prefix: "node-subset:",
                    includePatterns,
                  },
                ]),
          ...(qualifiedCore || (policy === "dual" && selectedCore)
            ? [
                {
                  runtime: "bun",
                  configs: [gatewayCoreConfig],
                  prefix: "bun:",
                  includePatterns: [gatewayWorkspaceHashTarget],
                },
              ]
            : []),
          { runtime: "bun", configs: [gatewayClientConfig], prefix: "bun:", includePatterns },
        ];
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
        expect(ciTestShardRequiresBun({ env: jobEnv, groups: [group] }, policy)).toBe(true);
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
                ).toEqual(expected[seen.length - 1]?.includePatterns);
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
      includePatterns: [gatewayWorkspaceHashTarget],
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

  it("finishes every release engine after ordinary test failures", async () => {
    const runChild = vi.fn(async (_args: string[], _env: NodeJS.ProcessEnv) => 1);
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
    ).resolves.toBe(1);
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

  it.each([
    {
      name: "runtime policy",
      env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "all-bun" },
      error: "Invalid OPENCLAW_CI_TEST_RUNTIME_POLICY",
    },
    {
      name: "NaN concurrency",
      concurrency: Number.NaN,
      error: "Shard plan concurrency must be a positive integer",
    },
    {
      name: "zero concurrency",
      concurrency: 0,
      error: "Shard plan concurrency must be a positive integer",
    },
  ])("rejects invalid $name before scheduling any child", async ({ env, concurrency, error }) => {
    const runChild = vi.fn(async () => 0);
    await expect(
      runShardPlans([{ kind: "group", name: "one", plan: { configs: [bunConfig] } }], {
        env: env ?? {},
        concurrency,
        scratchDir: makeScratchDir(),
        runChild,
      }),
    ).rejects.toThrow(error);
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
      const workerMemoryTest = "src/infra/worker-task-pool.memory.test.ts";
      const pluginRetentionTest = "src/plugins/runtime.retention.test.ts";
      const nodeHistoryBenchmark = "test/scripts/bench-session-history.test.ts";
      const nativeCompilerTest = "test/scripts/native-typescript.test.ts";
      const compilerGraphTest = "test/scripts/ts-topology.test.ts";
      const mixedCompilerTest = "src/plugin-sdk/provider-tools.test.ts";
      const bunVitestFiles = [
        "packages/markdown-core/src/render-aware-chunking.test.ts",
        workerMemoryTest,
        "src/shared/account-enabled.test.ts",
        vitestBunTarget,
        nativeCompilerTest,
        compilerGraphTest,
        mixedCompilerTest,
        pluginRetentionTest,
        "src/process/spawn-broker/proxy-retention.test.ts",
        "src/infra/main-thread-stall.test.ts",
        "src/auto-reply/reply/get-reply.imports.test.ts",
        "src/plugin-sdk/provider-catalog-shared.cancellation.test.ts",
      ].toSorted();
      const nodeFiles = [skippedOnBun, nodeHistoryBenchmark, nodeTarget];
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
    "runs qualified process coverage on Bun while retaining process siblings on Node under %s",
    async (policy) => {
      const bunFiles = [
        "src/process/spawn-broker/event-order.test.ts",
        "src/process/spawn-broker/group-custody.test.ts",
        "src/process/spawn-broker/context.test.ts",
        "src/process/spawn-broker/startup.test.ts",
        "src/process/terminal-pty.test.ts",
        "src/process/terminal-pty-bun.test.ts",
      ].toSorted();
      const nodeFiles = [
        "src/process/spawn-broker/cleanup.test.ts",
        "src/process/spawn-broker/execa.test.ts",
        "src/process/supervisor/service-child-relay-host.retirement.test.ts",
      ];
      const includePatterns = [...bunFiles, ...nodeFiles];
      const seen: Array<{ runtime: string | undefined; includes: string[] }> = [];
      await expect(
        runShardPlans(
          [
            {
              kind: "group",
              name: "process",
              plan: {
                configs: ["test/vitest/vitest.process.config.ts"],
                includePatterns,
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
        { runtime: "node", includes: policy === "dual" ? includePatterns : nodeFiles },
        { runtime: "bun", includes: bunFiles },
      ]);
      for (const bunFile of bunFiles) {
        expect(resolveCiTestRuntimeSelections({ targets: [bunFile] }, policy)).toEqual([
          ...(policy === "dual" ? [{ runtime: "node" }] : []),
          { runtime: "bun" },
        ]);
      }
    },
  );

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

  it.each([
    {
      policy: "bun-compatible",
      config: unitConfig,
      nodeFiles: ["packages/acp-core/src/error-format.test.ts"],
    },
    {
      policy: "bun-compatible",
      config: unitSrcConfig,
      nodeFiles: [],
    },
  ] as const)(
    "admits qualified unit coverage while preserving $config siblings under $policy",
    async ({ policy, config, nodeFiles }) => {
      const bunFiles = [
        ...(config === unitConfig ? [graphemeTarget] : []),
        "src/audit/audit-config.test.ts",
        libraryTarget,
        workerQuiescenceTarget,
        "src/node-host/node-worker-workspace-processes.test.ts",
        workerClosingWindowTarget,
        "src/worker/worker-deploy-entry.test.ts",
      ].toSorted();
      const includePatterns = [...bunFiles, ...nodeFiles];
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
        ...(nodeFiles.length ? [{ runtime: "node", includes: nodeFiles }] : []),
        { runtime: "bun", includes: bunFiles },
      ]);
      expect(new Set(seen.flatMap(({ includes }) => includes))).toEqual(new Set(includePatterns));
      for (const targets of [bunFiles, ...bunFiles.map((file) => [file])]) {
        expect(resolveCiTestRuntimeSelections({ targets }, policy)).toEqual([{ runtime: "bun" }]);
      }
      for (const nodeFile of nodeFiles) {
        expect(resolveCiTestRuntimeSelections({ targets: [nodeFile] }, policy)).toEqual([
          { runtime: "node" },
        ]);
      }
      const full = resolveCiTestRuntimeSelections({ configs: [config] }, policy);
      expect(full).toEqual([
        ...(nodeFiles.length
          ? [{ runtime: "node", includePatterns: expect.arrayContaining([...nodeFiles]) }]
          : []),
        { runtime: "bun", includePatterns: expect.arrayContaining(bunFiles) },
      ]);
      const nodeIncludes = full.find((entry) => entry.runtime === "node")?.includePatterns ?? [];
      const bunIncludes = full.find((entry) => entry.runtime === "bun")?.includePatterns ?? [];
      for (const file of bunFiles) {
        expect(nodeIncludes).not.toContain(file);
      }
      expect(nodeIncludes).not.toContain(bunTarget);
      if (config === unitSrcConfig) {
        expect(bunIncludes.every((file) => file.startsWith("src/"))).toBe(true);
        expect(
          bunIncludes.some(
            (file) => file.startsWith("src/acp/") || file.startsWith("src/security/"),
          ),
        ).toBe(false);
      }
      if (config === unitSrcConfig) {
        expect(
          resolveCiTestRuntimeSelections(
            { configs: [config], includePatterns: [graphemeTarget] },
            policy,
          ),
        ).toEqual([{ runtime: "node" }]);
      }
      expect(ciTestShardRequiresBun({ configs: [config] }, policy)).toBe(true);
    },
  );

  it.each([
    {
      config: "test/vitest/vitest.commands.config.ts",
      ownerIncludePatterns: ["src/commands/**/*.test.ts"],
      targets: [
        "src/commands/doctor-sqlite-nocow.test.ts",
        "src/commands/doctor-config-preflight.process.test.ts",
      ],
      otherOwner: "src/commands/doctor-security.test.ts",
    },
    {
      config: "test/vitest/vitest.gateway-methods.config.ts",
      ownerIncludePatterns: ["src/gateway/server-methods/**/*.test.ts"],
      targets: [
        "test/plugins/crabbox-allocation-authority.gateway.test.ts",
        "test/plugins/team-reports-http.gateway.test.ts",
      ],
      otherOwner: "src/gateway/server-methods/transcripts.test.ts",
    },
  ])("admits the complete $config owner without changing adjacent ownership", (row) => {
    for (const policy of ["node", "bun-compatible", "dual"] as const) {
      const expected =
        policy === "node"
          ? [{ runtime: "node" }]
          : policy === "dual"
            ? [{ runtime: "node" }, { runtime: "bun" }]
            : [{ runtime: "bun" }];
      for (const selection of [
        { configs: [row.config] },
        { configs: [row.config], includePatterns: row.targets },
        { configs: [row.config], includePatterns: row.ownerIncludePatterns },
        { targets: row.targets },
        ...row.targets.map((target) => ({ targets: [target] })),
      ]) {
        expect(resolveCiTestRuntimeSelections(selection, policy)).toEqual(expected);
        expect(ciTestShardRequiresBun(selection, policy)).toBe(policy !== "node");
        expect(
          resolveCiTestRuntimeSelections({ ...selection, vitestArgs: ["--shard=1/2"] }, policy),
        ).toEqual([{ runtime: "node" }]);
      }
      expect(resolveCiTestRuntimeSelections({ targets: [row.otherOwner] }, policy)).toEqual([
        { runtime: "node" },
      ]);
    }
  });

  it.each([
    {
      config: "test/vitest/vitest.extension-database-workers.config.ts",
      dir: "extensions",
      targets: [
        "extensions/codex/src/session-catalog-native-performance.test.ts",
        "extensions/team-reports/src/render/theme.test.ts",
      ],
      sibling: "extensions/team-reports/src/render/site.test.ts",
      glob: "**/*.test.ts",
    },
    {
      config: "test/vitest/vitest.infra.config.ts",
      dir: ".",
      targets: [
        "src/agents/prepared-model-catalog-worker.custody.integration.test.ts",
        "src/cli/admin-state-owner.process.test.ts",
        "src/infra/update-managed-service-handoff-reclamation.test.ts",
        "src/infra/worker-cpu.test.ts",
        "src/state/openclaw-state-lease.retention.test.ts",
      ],
      sibling: "src/state/openclaw-state-ownership.test.ts",
      glob: "**/*.test.ts",
    },
  ])("admits only the qualified complete selections in $config", (row) => {
    for (const policy of ["node", "bun-compatible", "dual"] as const) {
      const expected =
        policy === "node"
          ? [{ runtime: "node" }]
          : policy === "dual"
            ? [{ runtime: "node" }, { runtime: "bun" }]
            : [{ runtime: "bun" }];
      for (const targets of [row.targets, ...row.targets.map((target) => [target])]) {
        for (const selection of [
          { targets },
          { configs: [row.config], includePatterns: targets },
          {
            configs: [row.config],
            includePatterns: targets.map((target) =>
              row.dir && row.dir !== "." ? target.slice(row.dir.length + 1) : target,
            ),
          },
        ]) {
          expect(resolveCiTestRuntimeSelections(selection, policy)).toEqual(expected);
          expect(ciTestShardRequiresBun(selection, policy)).toBe(policy !== "node");
          expect(
            resolveCiTestRuntimeSelections({ ...selection, vitestArgs: ["--shard=1/2"] }, policy),
          ).toEqual([{ runtime: "node" }]);
        }
      }
      for (const includePatterns of [undefined, [], [row.glob]]) {
        const selection = { configs: [row.config], includePatterns };
        expect(resolveCiTestRuntimeSelections(selection, policy)).toEqual([
          { runtime: "node" },
          ...(policy === "dual" ? [{ runtime: "bun", includePatterns: row.targets }] : []),
        ]);
        expect(ciTestShardRequiresBun(selection, policy)).toBe(policy === "dual");
      }
      for (const target of row.targets) {
        const selection = { configs: [row.config], includePatterns: [target, row.sibling] };
        expect(resolveCiTestRuntimeSelections(selection, policy)).toEqual([
          { runtime: "node" },
          ...(policy === "dual" ? [{ runtime: "bun", includePatterns: [target] }] : []),
        ]);
        expect(ciTestShardRequiresBun(selection, policy)).toBe(policy === "dual");
      }
      for (const selection of [
        { targets: [row.sibling] },
        { targets: [...row.targets, row.sibling] },
        { configs: [row.config], includePatterns: [row.sibling] },
        { configs: [row.config], includePatterns: ["src/infra/worker-task-pool.memory.test.ts"] },
      ]) {
        expect(resolveCiTestRuntimeSelections(selection, policy)).toEqual([{ runtime: "node" }]);
      }
    }
  });

  it.each([
    { env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: "invalid" } },

    { targets: ["packages/markdown-core/src/*.test.ts"] },
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

  it("applies the UI runtime policy only to the Bun child under dual", async () => {
    vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
    const seen: Array<Record<string, string | undefined>> = [];
    await expect(
      runShardPlans([{ kind: "group", name: "ui", plan: { configs: ["ui/vitest.config.ts"] } }], {
        env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual" },
        scratchDir: makeScratchDir(),
        runChild: async (_args, env) => {
          if (env.OPENCLAW_VITEST_RUNTIME === "node") {
            expect(env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE).toBeUndefined();
          }
          seen.push({
            runtime: env.OPENCLAW_VITEST_RUNTIME,
            warmup: env.BUN_JSC_thresholdForFTLOptimizeAfterWarmUp,
            soon: env.BUN_JSC_thresholdForFTLOptimizeSoon,
            ftlEnabled: env.BUN_JSC_useFTLJIT,
            gcAllocationBytes: env.BUN_JSC_gcMaxHeapSize,
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
        gcAllocationBytes: undefined,
        allocatorInterval: undefined,
      },
      {
        runtime: "bun",
        warmup: "512000",
        soon: "8000",
        ftlEnabled: undefined,
        gcAllocationBytes: "268435456",
        allocatorInterval: "1000",
      },
    ];
    expect(seen).toEqual(expected);
  });

  it.each([
    { vitestArgs: ["--config", "another.config.ts"] },

    { vitestArgs: ["--reporter=custom.mts"] },
    { vitestArgs: ["--maxWorkers"] },
    { targets: ["ui/src/pages/skills/view.test.ts"] },
  ])("keeps unproven UI execution envelopes on Node: %s", (overrides) => {
    const selection = {
      configs: ["ui/vitest.config.ts"],
      ...overrides,
    };
    expect(resolveCiTestRuntimeSelections(selection, "dual")).toEqual([{ runtime: "node" }]);
    expect(ciTestShardRequiresBun(selection, "bun-compatible")).toBe(false);
  });

  it.each([
    { name: "explicit Node policy", policy: "node", expected: "2" },

    { name: "unlimited cgroup", constrainedGiB: 0, expected: "2" },

    { name: "portable host", portable: true, expected: "1" },

    { name: "caller cache", callerLeaf: true, expected: "1" },
  ])("admits inner singleton overlap from actual $name facts", async (scenario) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(scenario.portable ? "darwin" : "linux");
    vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
    vi.spyOn(os, "availableParallelism").mockReturnValue(2);
    vi.spyOn(os, "totalmem").mockReturnValue(7.65 * 1024 ** 3);
    vi.spyOn(process, "constrainedMemory").mockReturnValue(
      (scenario.constrainedGiB ?? 7.65) * 1024 ** 3,
    );
    const scratchDir = makeScratchDir();
    const files = [
      "extensions/telegram/src/telegram-ingress-spool.test.ts",
      "extensions/telegram/src/webhook.test.ts",
    ];
    const includes = files;
    const groups = Array.from({ length: 1 }, (_, index) => ({
      configs: ["test/vitest/vitest.extension-database-workers.config.ts"],
      shard_name: `changed-extensions-config-${index + 1}`,
      includePatterns: includes,
      requiresDist: false,
      env: {
        OPENCLAW_VITEST_MAX_WORKERS: "2",
        OPENCLAW_TEST_PROJECTS_PARALLEL: "2",
      },
    }));
    const runtimes: Array<string | undefined> = [];
    const runChild = vi.fn(async (_args, env) => {
      runtimes.push(env.OPENCLAW_VITEST_RUNTIME);
      expect(env.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe(scenario.expected);
      expect(env.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
      expect(JSON.parse(readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE, "utf8"))).toEqual(includes);
      return 0;
    });
    await expect(
      runShardPlans(resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(groups) }), {
        concurrency: 1,
        env: {
          CI: "1",
          RUNNER_ENVIRONMENT: "self-hosted",
          FROZEN_TARGET: "false",
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
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        OPENCLAW_CI_TEST_RUNTIME_POLICY: "bun-compatible",
        RAYON_NUM_THREADS: "1",
        TOKIO_WORKER_THREADS: "1",
      });
    },
  );

  it("builds child env with cache isolation, includes, overlays, and inherited worker ceilings", () => {
    const scratchDir = makeScratchDir();
    const entry = {
      kind: "group" as const,
      name: "g",
      plan: {
        configs: ["cfg.ts"],
        env: { EXTRA: "yes", IGNORED: 42, OPENCLAW_VITEST_MAX_WORKERS: "" },
        includePatterns: ["src/a.test.ts"],
        shard_name: "g",
      },
    };
    const childEnv = buildChildEnv(
      entry,
      {
        BASE: "1",
        EXTRA: "job",
        CI: "true",
        OPENCLAW_VITEST_MAX_WORKERS: "1",
        OPENCLAW_VITEST_INCLUDE_FILE: "stale.json",
      },
      scratchDir,
      3,
    );
    expect(childEnv.BASE).toBe("1");
    expect(childEnv.EXTRA).toBe("yes");
    expect(childEnv.IGNORED).toBeUndefined();
    expect(childEnv.OPENCLAW_VITEST_MAX_WORKERS).toBe("1");
    expect(resolveLocalVitestScheduling(childEnv, { cpuCount: 1 })).toEqual({
      maxWorkers: 1,
      fileParallelism: false,
      throttledBySystem: false,
    });
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

  it("rejects differing NODE_PATH before sharing a compiler", async () => {
    vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
    const scratchDir = makeScratchDir();
    vi.spyOn(os, "tmpdir").mockReturnValue(scratchDir);
    const runChild = vi.fn(async (_args: string[], _env: NodeJS.ProcessEnv) => 0);
    const plans = resolveShardPlans({
      OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
        { configs: ["one.config.ts"], includePatterns: ["src/one.test.ts"] },
        { configs: ["two.config.ts"], env: { NODE_PATH: "different-loader" } },
      ]),
    });
    const pending = runShardPlans(plans, {
      env: {},
      runChild,
    });
    await expect(pending).rejects.toThrow(
      "CI groups cannot share a compiler with differing NODE_PATH",
    );
    expect(runChild).not.toHaveBeenCalled();
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  it("joins ordinary spans around the Gateway barrier with stable cache lanes and include indices", async () => {
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
    const configs = ["a.config.ts", "b.config.ts", gatewayCoreConfig, "c.config.ts", "d.config.ts"];
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
  });

  it("serializes plans with a group-owned cache while retaining worker sizing", async () => {
    vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
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
            [gatewayCoreConfig, "b.config.ts", "c.config.ts"].map((config) => ({
              configs: [config],
              fallbackMaxWorkers: 2,
              env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(scratchDir, "caller") },
            })),
          ),
        }),
        {
          env: {
            CI: "true",
            RUNNER_ENVIRONMENT: "self-hosted",
            OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "2",
            OPENCLAW_VITEST_MAX_WORKERS: "8",
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
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(workers).toEqual(["8", "8", "8"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("admitted plans=1"));
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(createWorker.mock.calls[0]?.[0]).toMatchObject({
      RAYON_NUM_THREADS: "4",
      TOKIO_WORKER_THREADS: "4",
    });
    const run = createWorker.mock.results[0]!.value;
    expect(existsSync(run.descriptor.directory)).toBe(false);
  });

  it.each([
    {
      name: "below group memory floor",
      cpus: 8,
      gib: 24,
      minGib: 28,
      runner: "self-hosted",
      expected: "2",
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
    async ({ cpus, gib, minGib, runner, parallel, expected }) => {
      vi.spyOn(os, "availableParallelism").mockReturnValue(cpus);
      vi.spyOn(os, "totalmem").mockReturnValue(gib * 1024 ** 3);
      const runChild = vi.fn(async (_args: string[], _env: NodeJS.ProcessEnv) => 0);
      const plans = resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups([
          {
            configs: ["measured.config.ts"],
            fallbackMaxWorkers: 2,
            minTotalMemoryBytes: minGib === undefined ? undefined : minGib * 1024 ** 3,
          },
          { configs: ["ordinary.config.ts"] },
        ]),
      });
      await expect(
        runShardPlans(plans, {
          env: {
            CI: "true",
            RUNNER_ENVIRONMENT: runner,
            OPENCLAW_VITEST_MAX_WORKERS: "8",
            OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: parallel ? "2" : "1",
          },
          scratchDir: makeScratchDir(),
          runChild,
        }),
      ).resolves.toBe(0);
      expect(runChild.mock.calls.map(([, env]) => env.OPENCLAW_VITEST_MAX_WORKERS)).toEqual([
        expected,
        "8",
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
    const timings = refitTestTimings(runs).timings.compactGroupSeconds.blacksmith;
    expect(timings[timingKey]).toBe(10);
    expect(timings[`bun:${timingKey}`]).toBe(3);
    expect(timings[`bun-native:${timingKey}`]).toBe(2);
  });

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

  it("clones the restored Node runtime seed into isolated concurrent slots", () => {
    const persistentRoot = makeScratchDir();
    const prefix = "vitest-cache";
    const seed = path.join(persistentRoot, `${prefix}-0`);
    mkdirSync(seed, { recursive: true });
    writeFileSync(path.join(seed, "transform"), prefix, "utf8");
    const staleSlot = path.join(persistentRoot, `${prefix}-1`);
    mkdirSync(staleSlot, { recursive: true });
    writeFileSync(path.join(staleSlot, "stale"), "old", "utf8");

    expect(clonePersistentCacheSlots(persistentRoot, 3)).toBe(2);
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

  it.each([
    { name: "ordinary failure", code: 1, signal: null, complete: true },
    { name: "early stop", code: 1, signal: null, stop: true },
    { name: "infrastructure stop", code: 2, signal: null, stop: true },
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
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      if (String(chunk).startsWith("[shard:completion] ")) {
        expect(directories.some(existsSync)).toBe(false);
        receipts.push(String(chunk));
      }
      return true;
    });
    const pending = runShardPlans(
      ["one", "two"].map((name) => ({ kind: "target" as const, name, target: `${name}.test.ts` })),
      { concurrency: 1, env: { CI: "stop" in scenario ? "" : "true" } },
    );
    if ("rejects" in scenario) {
      await expect(pending).rejects.toThrow();
    } else {
      await expect(pending).resolves.toBe(
        scenario.signal === "SIGKILL" ? 137 : (scenario.code ?? 2),
      );
    }
    expect(spawn).toHaveBeenCalledTimes(
      "stop" in scenario || "unjoined" in scenario || scenario.code === null ? 1 : 2,
    );
    if (scenario.code !== 0 && !("unjoined" in scenario)) {
      expect(output.join("")).toContain(
        `[shard-failure:one] FAILED (exit ${scenario.signal === "SIGKILL" ? 137 : (scenario.code ?? 2)}${scenario.signal ? `, signal ${scenario.signal}` : ""})`,
      );
    }
    expect(receipts).toEqual(
      "complete" in scenario
        ? [
            `[shard:completion] {"version":1,"planned":2,"completed":2,"invocations":2,"failedInvocations":${scenario.code === 0 ? 0 : 1}}\n`,
          ]
        : [],
    );
  });

  it.each([
    { name: "first upstream attempt", attempt: "1", repository: "openclaw/openclaw" },
    { name: "failed-jobs retry", attempt: "2", repository: "openclaw/openclaw" },
    { name: "fork", attempt: "1", repository: "example/openclaw" },
  ])("drains every planned CI group after failure on $name", async ({ attempt, repository }) => {
    const started: string[] = [];
    const plans = ["first", "second", "third"].map((name) => ({
      kind: "group" as const,
      name,
      plan: { configs: [`${name}.config.ts`] },
    }));
    await expect(
      runShardPlans(plans, {
        concurrency: 1,
        env: { CI: "true", GITHUB_RUN_ATTEMPT: attempt, GITHUB_REPOSITORY: repository },
        scratchDir: makeScratchDir(),
        runChild: async (_args, _env, label) => {
          started.push(label);
          return label === "first" || label === "second" ? 1 : 0;
        },
      }),
    ).resolves.toBe(1);
    expect(started).toEqual(["first", "second", "third"]);
  });

  it.each([
    { name: "local default", env: {}, codes: [1, 0, 0], expected: 1, started: 1 },
    {
      name: "local opt-out",
      env: { OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE: "0" },
      codes: [1, 0, 0],
      expected: 1,
      started: 1,
    },
    {
      name: "local opt-in",
      env: { OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE: "1" },
      codes: [1, 1, 0],
      expected: 1,
      started: 3,
    },
    {
      name: "local infrastructure after failure",
      env: { OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE: "1" },
      codes: [1, 2, 0],
      expected: 2,
      started: 2,
    },
    {
      name: "CI infrastructure after failure",
      env: { CI: "1" },
      codes: [1, 2, 0],
      expected: 2,
      started: 2,
    },
    {
      name: "CI ignores local opt-out",
      env: { CI: "1", OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE: "0" },
      codes: [1, 0, 0],
      expected: 1,
      started: 3,
    },
  ])(
    "preserves the ordinary failure boundary for $name",
    async ({ env, codes, expected, started }) => {
      const labels: string[] = [];
      const plans = ["first", "second", "third"].map((name) => ({
        kind: "target" as const,
        name,
        target: `${name}.test.ts`,
      }));
      await expect(
        runShardPlans(plans, {
          concurrency: 1,
          env: testRunnerFixtureEnv(env, {}),
          scratchDir: makeScratchDir(),
          runChild: async (_args, _env, label) => {
            labels.push(label);
            return codes[labels.length - 1]!;
          },
        }),
      ).resolves.toBe(expected);
      expect(labels).toEqual(plans.slice(0, started).map((plan) => plan.name));
    },
  );

  it("stops admitting groups after a malformed CI plan", async () => {
    const started: string[] = [];
    const exitCode = await runShardPlans(
      [
        { kind: "group" as const, name: "broken", plan: { configs: [] } },
        { kind: "group" as const, name: "next", plan: { configs: ["next.config.ts"] } },
      ],
      {
        concurrency: 1,
        env: { CI: "true" },
        runChild: async (_args, _env, label) => {
          started.push(label);
          return 0;
        },
        scratchDir: makeScratchDir(),
      },
    );

    expect(exitCode).toBe(2);
    expect(started).toEqual([]);
  });
});
