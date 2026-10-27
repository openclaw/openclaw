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
  resolveShardPlans,
  resolveTestProjectsEntrypoint,
  runShardPlans,
  type ShardGroupPlan,
} from "../../scripts/ci-run-node-test-shard.mts";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import nativeBunQualification from "../../scripts/lib/ci-test-native-bun-qualification.json" with { type: "json" };
import { resolveCiTestRuntimeSelections } from "../../scripts/lib/ci-test-runtime.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import { collectVitestFileFilters } from "../../scripts/lib/vitest-cli-mode.mts";
import * as workerOwner from "../../scripts/lib/vitest-worker-run.mts";
import { createVitestRunSpecs } from "../../scripts/test-projects.test-support.mts";
import * as groupOwner from "../../scripts/vitest-process-group.mts";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

const gatewayCoreConfig = "test/vitest/vitest.gateway-core.config.ts";

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
const bunTarget = nativeQualificationFixtures.first;
const vitestBunTarget = "src/agents/sandbox/docker.execDockerRaw.enoent.test.ts";
const nativeBunTarget = nativeQualificationFixtures.second;
const nodeTarget = "src/cli/cli-process-diagnostics.test.ts";
const pendingInputWeakRefTarget =
  "src/config/sessions/session-accessor.pending-input-retention.test.ts";
const pendingInputBunControl = "src/config/sessions/session-accessor.pending-inputs.test.ts";
const overlapEnv = {
  CI: "1",
  RUNNER_ENVIRONMENT: "self-hosted",
  FROZEN_TARGET: "false",
  OPENCLAW_CI_TEST_RUNTIME_POLICY: "node",
};
function singletonGroup() {
  return {
    configs: ["test/vitest/vitest.extension-database-workers.config.ts"],
    shard_name: "changed-extensions-config-1",
    includePatterns: [
      "extensions/telegram/src/telegram-ingress-spool.test.ts",
      "extensions/telegram/src/webhook.test.ts",
    ],
    env: { OPENCLAW_VITEST_MAX_WORKERS: "2", OPENCLAW_TEST_PROJECTS_PARALLEL: "2" },
  };
}

function group(
  name: string,
  configs: string[],
  plan: Partial<ShardGroupPlan["plan"]> = {},
): ShardGroupPlan {
  return { kind: "group", name, plan: { configs, ...plan } };
}

function groupPlans(groups: ShardGroupPlan["plan"][], packed = false) {
  return resolveShardPlans(
    packed
      ? { OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups(groups) }
      : { OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(groups) },
  );
}

function machine(cpus: number, gib: number) {
  vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
  vi.spyOn(os, "availableParallelism").mockReturnValue(cpus);
  vi.spyOn(os, "totalmem").mockReturnValue(gib * 1024 ** 3);
}

type RunOptions = NonNullable<Parameters<typeof runShardPlans>[1]>;
function runPlans(plans: Parameters<typeof runShardPlans>[0], options: RunOptions = {}) {
  return runShardPlans(plans, {
    env: {},
    ...options,
    scratchDir: options.scratchDir ?? makeScratchDir(),
  });
}

async function recordPlans(
  plans: Parameters<typeof runShardPlans>[0],
  options: RunOptions = {},
  outcome = 0,
) {
  const runChild = vi.fn<NonNullable<RunOptions["runChild"]>>().mockResolvedValue(outcome);
  const code = await runPlans(plans, { ...options, runChild });
  return { code, calls: runChild.mock.calls };
}

const readList = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

function captureChild() {
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
  const pending = runPlans([group("compact", ["one.config.ts"])]);
  return { child, output, pending, started: started.promise };
}

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
  it.each([{ flags: ["--root", "alternate"] }])(
    "preserves the native Gateway invocation for $flags",
    ({ flags }) => {
      const config = "test/vitest/vitest.gateway-server.config.ts";
      const specs = createVitestRunSpecs([config, "--", ...flags], { baseEnv: {} });
      expect(specs.map((spec) => spec.pnpmArgs.slice(spec.pnpmArgs.indexOf("--config")))).toEqual([
        ["--config", config, ...flags],
      ]);
    },
  );

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
      const code = await runPlans(
        [
          {
            ...group("agent-chat", [config], { includePatterns: included }),
            timingKey: "original-key",
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

  it("drains admitted peers before reporting a rejected runner and removing scratch", async () => {
    vi.spyOn(groupOwner, "shouldUseDetachedVitestProcessGroup").mockReturnValue(true);
    const held = createDeferred();
    const failed = createDeferred();
    const failure = new Error("runner rejected");
    let calls = 0;
    let scratch = "";
    let settled = false;
    const pending = runShardPlans(
      ["a", "b", "c"].map((name) => group(name, [`${name}.config.ts`])),
      {
        concurrency: 2,
        env: {},
        runChild: async (_args, env) => {
          scratch = path.dirname(env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT!);
          if (++calls === 1) {
            scratchDirs.push(scratch);
            await held.promise;
            return 0;
          }
          failed.resolve();
          throw failure;
        },
      },
    )
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    try {
      await failed.promise;
      await nextTurn();
      expect(settled).toBe(false);
      expect(existsSync(scratch)).toBe(true);
    } finally {
      held.resolve();
      await pending;
    }
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(AggregateError);
    expect(outcome).toHaveProperty("errors", [failure]);
    expect(calls).toBe(2);
    expect(existsSync(scratch)).toBe(false);
  });

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
      const pending = runPlans(
        [
          { kind: "target", name: ui ? "LINE" : "AI package", target },
          ...(ui
            ? [
                group("Doctor", ["test/vitest/vitest.e2e.config.ts"], {
                  includePatterns: [
                    "test/e2e/qa-lab/runtime/doctor-auth-secretref-checks.e2e.test.ts",
                  ],
                }),
                group("Explicit skip", ["test/vitest/vitest.e2e.config.ts"], {
                  env: { OPENCLAW_E2E_SKIP_BUILD: "1" },
                }),
              ]
            : []),
        ],
        {
          env: { OPENCLAW_E2E_USE_PREBUILT_DIST: "1" },
          runChild,
        },
      );
      await started.promise;
      expect(runChild).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledOnce();
      if (ui) {
        expect(prepare.mock.calls[0]?.[0].map((selection) => selection.includePatterns)).toEqual([
          [target],
          ["test/e2e/qa-lab/runtime/doctor-auth-secretref-checks.e2e.test.ts"],
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
      await runPlans([{ kind: "target", name: "LINE", target }], {
        env: {
          OPENCLAW_E2E_USE_PREBUILT_DIST: "1",
          OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--exclude", target]),
        },
        runChild,
      }),
    ).toBe(0);
    expect(prepare).toHaveResolvedWith(0);
    const selection = prepare.mock.calls[0]![0][0]!;
    expect(selection.matchesFile?.(target, true, selection.includePatterns)).toBe(false);
  });

  it("preserves workflow commands at column zero while labeling child stdout", async () => {
    const { child, output, pending, started } = captureChild();
    await started;
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
    child.stdout!.emit("data", bytes.subarray(0, 20));
    child.stdout!.emit("data", bytes.subarray(20));
    child.emit("close", 1);
    await expect(pending).resolves.toBe(1);
    const logged = output.join("").split("\n");
    expect(logged[0]).toBe("[shard:compact] begin");
    expect(logged).toContain("[shard:compact] end (exit 1)");
    expect(logged.filter((line) => line.startsWith("::"))).toEqual([
      ...lines.slice(1, 5),
      lines[7],
    ]);
    for (const line of [lines[0], lines[5], lines[6]]) {
      expect(logged).toContain(`[shard:compact] ${line}`);
    }
    expect(logged.filter((line) => line.startsWith("[shard-failure:compact:tail]"))).toEqual(
      lines.map((line) => `[shard-failure:compact:tail] ${line}`),
    );
  });

  it.each([
    { code: 7, signal: null, exit: 7 },
    { code: null, signal: "SIGTERM", exit: 143 },
    { code: 0, signal: null, exit: 0 },
  ] as const)("keeps invocation diagnostics searchable after exit $exit", async (outcome) => {
    const { child, output, pending, started } = captureChild();
    await started;
    child.stdout!.emit("data", `${"old output".repeat(3_000)}\n`);
    child.stdout!.emit("data", "binary\0output\n");
    child.stderr!.emit("data", "::error::root failure\nunterminated diagnostic");
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

  it("fails clearly when the candidate has no test-projects entrypoint", () => {
    expect(() => resolveTestProjectsEntrypoint(() => false)).toThrow(
      "CI target does not provide scripts/test-projects.mts or .mjs",
    );
  });

  it("finishes every release engine after ordinary test failures", async () => {
    const { code, calls } = await recordPlans(
      groupPlans([
        {
          configs: [bunConfig],
          shard_name: "eligible",
          timing_key: "timing",
          includePatterns: [nodeTarget, vitestBunTarget, nativeBunTarget],
        },
        { configs: ["later.config.ts"], shard_name: "later" },
      ]),
      { concurrency: 1, env: { CI: "true", OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual-all" } },
      1,
    );
    expect(code).toBe(1);
    expect(calls.map(([, env]) => env.OPENCLAW_VITEST_RUNTIME)).toEqual([
      "node",
      "bun",
      "bun",
      "node",
      "bun",
    ]);
    expect(
      new Set(calls.slice(0, 2).map(([, env]) => env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT)).size,
    ).toBe(2);
    expect(calls[2]?.[0]).toEqual(["--native-bun", `./${nativeBunTarget}`]);
    expect(calls[2]?.[1].OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT).toBeUndefined();
    expect(calls.map((call) => call.slice(2))).toEqual([
      ["eligible", "timing"],
      ["bun:eligible", "bun:timing"],
      ["bun-native:eligible", "bun-native:timing"],
      ["later", "later"],
      ["bun:later", "bun:later"],
    ]);
  });

  it.each([
    {
      name: "runtime policy",
      env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "all-bun" },
      error: "Invalid OPENCLAW_CI_TEST_RUNTIME_POLICY",
    },
    {
      name: "zero concurrency",
      concurrency: 0,
      error: "Shard plan concurrency must be a positive integer",
    },
  ])("rejects invalid $name before scheduling any child", async ({ env, concurrency, error }) => {
    const runChild = vi.fn(async () => 0);
    await expect(
      runPlans([group("one", [bunConfig])], {
        env: env ?? {},
        concurrency,
        runChild,
      }),
    ).rejects.toThrow(error);
    expect(runChild).not.toHaveBeenCalled();
  });

  it("keeps exact native admission and Vitest-only arguments separate", () => {
    const selection = { targets: [nativeBunTarget] };
    expect(resolveCiTestRuntimeSelections(selection, "node")).toEqual([{ runtime: "node" }]);
    expect(resolveCiTestRuntimeSelections(selection, "dual-all")).toEqual([
      { runtime: "node" },
      { runtime: "bun", engine: "bun-test", files: [nativeBunTarget] },
    ]);
    for (const vitestArgs of [["--testNamePattern=(?!)"]]) {
      expect(resolveCiTestRuntimeSelections({ ...selection, vitestArgs }, "bun-all")).toEqual([
        { runtime: "bun" },
      ]);
    }
    expect(
      resolveCiTestRuntimeSelections({ targets: [nativeBunTarget, vitestBunTarget] }, "bun-all"),
    ).toEqual([{ runtime: "bun" }]);
  });

  it("keeps only the pending-input WeakRef contract on Node", () => {
    expect(
      resolveCiTestRuntimeSelections({ targets: [pendingInputWeakRefTarget] }, "bun-all"),
    ).toEqual([{ runtime: "node" }]);
    expect(
      resolveCiTestRuntimeSelections({ targets: [pendingInputBunControl] }, "bun-all"),
    ).toEqual([{ runtime: "bun" }]);
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
    expect(resolveCiTestRuntimeSelections(selection, "bun-all", cwd)).toEqual([
      { runtime: "bun", engine: "bun-test", files },
    ]);
    writeFileSync(path.join(cwd, nativeBunTarget), `${readFileSync(nativeBunTarget, "utf8")}\n`);
    expect(resolveCiTestRuntimeSelections(selection, "dual-all", cwd)).toEqual([
      { runtime: "node" },
      { runtime: "bun", includePatterns: [nativeBunTarget] },
      { runtime: "bun", engine: "bun-test", files: [bunTarget, helperTest] },
    ]);
    writeFileSync(path.join(cwd, helper), "// changed fixture helper\n");
    expect(resolveCiTestRuntimeSelections(selection, "dual-all", cwd)).toEqual([
      { runtime: "node" },
      { runtime: "bun", includePatterns: [helperTest, nativeBunTarget] },
      { runtime: "bun", engine: "bun-test", files: [bunTarget] },
    ]);
    writeFileSync(path.join(cwd, setup), "// changed setup\n");
    expect(resolveCiTestRuntimeSelections(selection, "dual-all", cwd)).toEqual([
      { runtime: "node" },
      { runtime: "bun" },
    ]);
  });

  it("applies the UI runtime policy only to the Bun child under dual-all", async () => {
    const { code, calls } = await recordPlans([group("ui", ["ui/vitest.config.ts"])], {
      env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual-all" },
    });
    expect(code).toBe(0);
    const keys = ["OPENCLAW_VITEST_RUNTIME", "BUN_JSC_gcMaxHeapSize"];
    expect(calls.map(([, env]) => keys.map((key) => env[key]))).toEqual([
      ["node", undefined],
      ["bun", "268435456"],
    ]);
    expect(calls[0]?.[1].OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE).toBeUndefined();
  });

  it.each([
    { name: "explicit Node policy", expected: "2" },
    { name: "unlimited cgroup", constrainedGiB: 0, expected: "2" },
    { name: "portable host", portable: true, expected: "1" },
    { name: "caller cache", callerLeaf: true, expected: "1" },
  ])("admits inner singleton overlap from actual $name facts", async (scenario) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(scenario.portable ? "darwin" : "linux");
    machine(2, 7.65);
    vi.spyOn(process, "constrainedMemory").mockReturnValue(
      (scenario.constrainedGiB ?? 7.65) * 1024 ** 3,
    );
    const scratchDir = makeScratchDir();
    const entry = singletonGroup();
    const { code, calls } = await recordPlans(groupPlans([entry]), {
      concurrency: 1,
      scratchDir,
      env: {
        ...overlapEnv,
        ...(scenario.callerLeaf
          ? {
              OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: scratchDir,
              OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(scratchDir, "caller"),
            }
          : {}),
      },
    });
    expect(code).toBe(0);
    expect(
      calls.map(([, env]) => [
        env.OPENCLAW_TEST_PROJECTS_PARALLEL,
        env.OPENCLAW_VITEST_MAX_WORKERS,
        env.OPENCLAW_VITEST_RUNTIME,
        readList(env.OPENCLAW_VITEST_INCLUDE_FILE!),
      ]),
    ).toEqual([[scenario.expected, "2", "node", entry.includePatterns]]);
  });

  it("builds child env with cache isolation, includes, overlays, and inherited worker ceilings", () => {
    const scratchDir = makeScratchDir();
    const entry = group("g", ["cfg.ts"], {
      env: { EXTRA: "yes", IGNORED: 42, OPENCLAW_VITEST_MAX_WORKERS: "" },
      includePatterns: ["src/a.test.ts"],
      shard_name: "g",
    });
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
    expect(childEnv).toMatchObject({
      BASE: "1",
      EXTRA: "yes",
      OPENCLAW_VITEST_MAX_WORKERS: "1",
      OPENCLAW_VITEST_SHARD_NAME: "g",
      OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
      OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: path.join(scratchDir, "vitest-cache-3"),
      OPENCLAW_VITEST_INCLUDE_FILE: path.join(scratchDir, "node-test-include-3.json"),
    });
    expect(childEnv.IGNORED).toBeUndefined();
    expect(childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBeUndefined();
    expect(JSON.parse(readFileSync(childEnv.OPENCLAW_VITEST_INCLUDE_FILE ?? "", "utf8"))).toEqual([
      "src/a.test.ts",
    ]);

    const bare = buildChildEnv(
      group("bare", ["cfg.ts"]),
      {
        OPENCLAW_VITEST_INCLUDE_FILE: "stale.json",
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: scratchDir,
      },
      scratchDir,
      0,
    );
    expect(bare.OPENCLAW_VITEST_INCLUDE_FILE).toBeUndefined();
    expect(bare.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT).toBe(path.join(scratchDir, "vitest-cache-0"));
    expect(bare.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBeUndefined();

    const explicit = buildChildEnv(
      group("explicit", ["cfg.ts"]),
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
    const plans = groupPlans([
      { configs: ["one.config.ts"], includePatterns: ["src/one.test.ts"] },
      { configs: ["two.config.ts"], env: { NODE_PATH: "different-loader" } },
    ]);
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
    machine(8, 24);
    const gates = Array.from({ length: 5 }, () => createDeferred<number>());
    const admissions = gates.map(() => createDeferred());
    const seen: Array<[string, string, string, string | undefined]> = [];
    const configs = ["a.config.ts", "b.config.ts", gatewayCoreConfig, "c.config.ts", "d.config.ts"];
    const scratchDir = makeScratchDir();
    const pending = runPlans(
      groupPlans(
        configs.map((config, index) => ({
          configs: [config],
          shard_name: String(index),
          includePatterns: [`src/${index}.test.ts`],
          fallbackMaxWorkers: 2,
          env: { OPENCLAW_VITEST_MAX_WORKERS: "8" },
        })),
      ),
      {
        env: {
          CI: "1",
          RUNNER_ENVIRONMENT: "self-hosted",
          OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: scratchDir,
        },
        scratchDir,
        runChild: async (_args, env, label) => {
          seen.push([
            label,
            env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT!,
            env.OPENCLAW_VITEST_INCLUDE_FILE!,
            env.OPENCLAW_VITEST_MAX_WORKERS,
          ]);
          admissions[Number(label)]!.resolve();
          return gates[Number(label)]!.promise;
        },
      },
    );
    const admitted = (indices: number[]) =>
      withTestTimeout(
        Promise.race([Promise.all(indices.map((index) => admissions[index]!.promise)), pending]),
        1_000,
        "plan admission",
      );
    try {
      await admitted([0, 1]);
      expect(seen).toHaveLength(2);
      gates[0]!.resolve(0);
      await nextTurn();
      expect(seen).toHaveLength(2);
      gates[1]!.resolve(0);
      await admitted([2]);
      expect(seen).toHaveLength(3);
      expect(seen[2]![3]).toBe("8");
      gates[2]!.resolve(0);
      await admitted([3, 4]);
      expect(seen).toHaveLength(5);
      expect(
        seen.map(([label, cache, include, workers]) => [
          label,
          path.basename(cache),
          path.basename(include),
          readList(include),
          workers,
        ]),
      ).toEqual(
        [0, 1, 0, 0, 1].map((slot, index) => [
          String(index),
          `vitest-cache-${slot}`,
          `node-test-include-${index}.json`,
          [`src/${index}.test.ts`],
          index === 2 ? "8" : "2",
        ]),
      );
    } finally {
      gates.forEach((gate) => gate.resolve(0));
      await expect(pending).resolves.toBe(0);
    }
  });

  it("serializes plans with a group-owned cache while retaining worker sizing", async () => {
    machine(8, 31);
    const createWorker = vi.spyOn(workerOwner, "createVitestWorkerRun");
    const scratchDir = makeScratchDir();
    let active = 0;
    let peak = 0;
    const workers: Array<string | undefined> = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      runPlans(
        groupPlans(
          [gatewayCoreConfig, "b.config.ts", "c.config.ts"].map((config) => ({
            configs: [config],
            fallbackMaxWorkers: 2,
            env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(scratchDir, "caller") },
          })),
        ),
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

  it("retains the measured group's fallback ceiling below its memory floor", async () => {
    vi.spyOn(os, "availableParallelism").mockReturnValue(8);
    vi.spyOn(os, "totalmem").mockReturnValue(24 * 1024 ** 3);
    const { code, calls } = await recordPlans(
      groupPlans(
        [
          {
            configs: ["measured.config.ts"],
            fallbackMaxWorkers: 2,
            minTotalMemoryBytes: 28 * 1024 ** 3,
          },
          { configs: ["ordinary.config.ts"] },
        ],
        true,
      ),
      {
        concurrency: 1,
        env: { CI: "true", RUNNER_ENVIRONMENT: "self-hosted", OPENCLAW_VITEST_MAX_WORKERS: "8" },
      },
    );
    expect(code).toBe(0);
    expect(calls.map(([, env]) => env.OPENCLAW_VITEST_MAX_WORKERS)).toEqual(["2", "8"]);
  });

  it.each([undefined, "node", "bun-all", "dual-all"] as const)(
    "reuses isolated cache slots for the selected runtime policy %s",
    async (policy) => {
      const scratchDir = makeScratchDir();
      const persistentRoot = path.join(makeScratchDir(), "persistent");
      for (const prefix of ["vitest-cache", "vitest-cache-bun"]) {
        const seed = path.join(persistentRoot, `${prefix}-0`);
        mkdirSync(seed, { recursive: true });
        writeFileSync(path.join(seed, "transform"), prefix, "utf8");
      }
      const unusedBunSlot = path.join(persistentRoot, "vitest-cache-bun-1");
      mkdirSync(unusedBunSlot);
      writeFileSync(path.join(unusedBunSlot, "untouched"), "retain", "utf8");
      const seenCaches = new Set<string>();
      const activeCaches = new Set<string>();
      let sharedWriter = false;
      const exitCode = await runShardPlans(
        resolveShardPlans({
          OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
            ["a", "b", "c", "d"].map((name) => ({
              configs: [bunConfig],
              shard_name: name,
              includePatterns: [nodeTarget, vitestBunTarget],
            })),
          ),
        }),
        {
          concurrency: 2,
          env: {
            OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: persistentRoot,
            OPENCLAW_CI_TEST_RUNTIME_POLICY: policy,
          },
          runChild: async (_args: string[], childEnv: Record<string, string | undefined>) => {
            const cache = childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT ?? "";
            expect(readFileSync(path.join(cache, "transform"), "utf8")).toBe(
              childEnv.OPENCLAW_VITEST_RUNTIME === "bun" ? "vitest-cache-bun" : "vitest-cache",
            );
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
      const prefixes =
        policy === "bun-all" || policy === "dual-all"
          ? ["vitest-cache", "vitest-cache-bun"]
          : ["vitest-cache"];
      expect([...seenCaches].toSorted()).toEqual(
        prefixes
          .flatMap((prefix) => [0, 1].map((slot) => path.join(persistentRoot, `${prefix}-${slot}`)))
          .toSorted(),
      );
      const nodeSlot = path.join(persistentRoot, "vitest-cache-1", "transform");
      expect(readFileSync(nodeSlot, "utf8")).toBe("vitest-cache");
      writeFileSync(nodeSlot, "changed", "utf8");
      expect(readFileSync(path.join(persistentRoot, "vitest-cache-0", "transform"), "utf8")).toBe(
        "vitest-cache",
      );
      if (policy === "bun-all" || policy === "dual-all") {
        expect(existsSync(path.join(unusedBunSlot, "untouched"))).toBe(false);
        expect(readFileSync(path.join(unusedBunSlot, "transform"), "utf8")).toBe(
          "vitest-cache-bun",
        );
      } else {
        expect(readFileSync(path.join(unusedBunSlot, "untouched"), "utf8")).toBe("retain");
        expect(existsSync(path.join(unusedBunSlot, "transform"))).toBe(false);
      }
    },
  );

  it("clones the restored Node runtime seed into isolated concurrent slots", () => {
    const persistentRoot = makeScratchDir();
    const prefix = "vitest-cache";
    const seed = path.join(persistentRoot, `${prefix}-0`);
    mkdirSync(seed, { recursive: true });
    writeFileSync(path.join(seed, "transform"), prefix, "utf8");
    const staleSlot = path.join(persistentRoot, `${prefix}-1`);
    mkdirSync(staleSlot, { recursive: true });
    writeFileSync(path.join(staleSlot, "stale"), "old", "utf8");

    expect(clonePersistentCacheSlots(persistentRoot, 3, "node")).toBe(2);
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

  it.each([
    { concurrency: 1, seeded: true },
    { concurrency: 2, seeded: false },
  ])(
    "leaves unused slots intact with $concurrency lanes and seeded=$seeded",
    ({ concurrency, seeded }) => {
      const persistentRoot = makeScratchDir();
      for (const prefix of ["vitest-cache", "vitest-cache-bun"]) {
        const slot = path.join(persistentRoot, `${prefix}-1`);
        mkdirSync(slot);
        writeFileSync(path.join(slot, "untouched"), "retain");
        if (seeded) {
          const seed = path.join(persistentRoot, `${prefix}-0`);
          mkdirSync(seed);
          writeFileSync(path.join(seed, "transform"), prefix);
        }
      }
      expect(clonePersistentCacheSlots(persistentRoot, concurrency, "dual-all")).toBe(0);
      for (const prefix of ["vitest-cache", "vitest-cache-bun"]) {
        expect(readFileSync(path.join(persistentRoot, `${prefix}-1`, "untouched"), "utf8")).toBe(
          "retain",
        );
      }
    },
  );

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
      runPlans(plans, {
        concurrency: 1,
        env: {
          OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: persistentRoot,
          OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER: writer,
        },
        fsModuleCacheMaxBytes: 0,
        runChild: async () => 0,
      });

    await run("0");
    expect(existsSync(transform)).toBe(true);
    await run("1");
    expect(existsSync(transform)).toBe(false);
  });

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
        runPlans(plans, {
          concurrency: 1,
          env: testRunnerFixtureEnv(env, {}),
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
    const { code, calls } = await recordPlans(
      [group("broken", []), group("next", ["next.config.ts"])],
      {
        concurrency: 1,
        env: { CI: "true" },
      },
    );
    expect({ code, calls }).toEqual({ code: 2, calls: [] });
  });
});
