import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  armPlan,
  gatewayEnv,
  IOS_RELEASE_TESTS,
  MODEL_REF,
  parseMeasurement,
  requireExactTestResult,
  runTrials,
  summarizeMeasurements,
  testRunnerEnv,
  type TestIdentity,
  type TrialDependencies,
} from "../../scripts/ios-release-e2e.js";
import { createNativeDependencies } from "../../scripts/lib/ios-release-e2e-native.js";
import { GatewayTransportError } from "../../src/gateway/transport-error.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression } from "./ci-workflow.test-support.js";

const nativeMocks = vi.hoisted(() => ({
  command: vi.fn(),
  build: vi.fn(),
  gateway: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("../../scripts/lib/managed-child-process.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mjs")>()),
  runManagedCommand: nativeMocks.command,
}));
vi.mock("../../scripts/lib/ios-release-e2e-build.js", () => ({
  prepareIOSReleaseNativeBuild: nativeMocks.build,
}));
vi.mock("../helpers/openclaw-test-instance.js", () => ({
  createOpenClawTestInstance: nativeMocks.gateway,
}));
vi.mock("../../src/gateway/call.js", () => ({ callGateway: nativeMocks.rpc }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  nativeMocks.command.mockReset();
  nativeMocks.build.mockReset();
  nativeMocks.gateway.mockReset();
  nativeMocks.rpc.mockReset();
});

function result(
  test: string = IOS_RELEASE_TESTS[0],
  overrides: Record<string, unknown> = {},
  bundleOverrides: Record<string, unknown> = {},
) {
  return {
    testNodes: [
      {
        nodeType: "Test Plan",
        children: [
          {
            nodeType: "UI test bundle",
            name: test.split("/")[0],
            children: [
              {
                nodeType: "Test Suite",
                children: [
                  {
                    nodeType: "Test Case",
                    nodeIdentifier: `${test.split("/").slice(1).join("/")}()`,
                    result: "Passed",
                    ...overrides,
                  },
                ],
              },
            ],
            ...bundleOverrides,
          },
        ],
      },
    ],
  };
}

describe("iOS release test identity", () => {
  it("accepts XCTest class/method identity under its exact UI bundle", () => {
    for (const test of IOS_RELEASE_TESTS) {
      requireExactTestResult(
        result(test, { children: [{ nodeType: "Test Case Run", result: "Passed" }] }),
        test,
      );
    }
  });

  it.each([
    ["basename", { nodeIdentifier: IOS_RELEASE_TESTS[0].split("/").at(-1) }],
    ["skipped", { result: "Skipped" }],
    ["failed", { result: "Failed" }],
    ["failed child", { children: [{ nodeType: "Test Case Run", result: "Failed" }] }],
    ["wrong class", { nodeIdentifier: "OtherTests/testLiveGatewayPairChatAndRelaunch()" }],
    [
      "retry to green",
      {
        children: [
          { nodeType: "Repetition", result: "Passed" },
          { nodeType: "Repetition", result: "Passed" },
        ],
      },
    ],
    [
      "multiple runs",
      {
        children: [
          { nodeType: "Test Case Run", result: "Passed" },
          { nodeType: "Test Case Run", result: "Passed" },
        ],
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    expect(() =>
      requireExactTestResult(result(undefined, overrides), IOS_RELEASE_TESTS[0]),
    ).toThrow();
  });

  it("rejects a wrong target or a unit bundle even with the exact class/method", () => {
    const wrongTarget = result(undefined, {}, { name: "OtherUITests" });
    expect(() => requireExactTestResult(wrongTarget, IOS_RELEASE_TESTS[0])).toThrow();
    const unitBundle = result(undefined, {}, { nodeType: "Unit test bundle" });
    expect(() => requireExactTestResult(unitBundle, IOS_RELEASE_TESTS[0])).toThrow();
  });

  it("rejects missing and extra tests", () => {
    expect(() => requireExactTestResult({ testNodes: [] }, IOS_RELEASE_TESTS[0])).toThrow();
    const extra = result();
    extra.testNodes.push(...result(IOS_RELEASE_TESTS[1]).testNodes);
    expect(() => requireExactTestResult(extra, IOS_RELEASE_TESTS[0])).toThrow();
  });
});

it("writes a failure proof when the real CLI rejects an impossible target", () => {
  const output = path.join(tempDirs.make("ios-release-e2e-cli-"), "proof.json");
  const targetSha = "0".repeat(40);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/ios-release-e2e.ts",
      "--mode",
      "stock",
      "--target-sha",
      targetSha,
      "--output",
      output,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status, child.stderr).toBe(1);
  const proof = JSON.parse(readFileSync(output, "utf8"));
  expect(proof).toMatchObject({
    targetSha,
    mode: "stock",
    status: "failed",
    trials: [],
    errors: ["gate-setup-failed"],
  });
  expect(proof.gatewayBuildMs).toBeUndefined();
  expect(proof.nativeBuildMs).toBeUndefined();
});

describe("sampled simulator-tree footprint", () => {
  const sample = { processes: 80, bytes: 1024, cpu: 1.5 };
  it("keeps only public measurement fields and reports a sampled maximum", () => {
    expect(parseMeasurement({ ...sample, udid: "private" })).toEqual(sample);
    expect(
      summarizeMeasurements(
        [
          { ...sample, atMs: 0 },
          { ...sample, bytes: 2048, atMs: 1000 },
        ],
        0,
        1800,
      ),
    ).toMatchObject({
      complete: true,
      peakBytes: 2048,
      metric: "simulator-tree-phys-footprint",
      window: "boot-complete-test",
    });
  });
  it.each([
    {},
    { ...sample, bytes: 0 },
    { ...sample, bytes: -1 },
    { ...sample, bytes: "1024" },
    { ...sample, processes: 0 },
    { ...sample, cpu: Number.NaN },
  ])("rejects invalid samples %j", (value) => {
    expect(() => parseMeasurement(value)).toThrow();
  });
  it("fails missing samples, errors, and uncovered beginning/end gaps", () => {
    const samples = [
      { ...sample, atMs: 0 },
      { ...sample, atMs: 1000 },
    ];
    expect(summarizeMeasurements([], 0, 1000).complete).toBe(false);
    expect(summarizeMeasurements(samples, 1, 1000).complete).toBe(false);
    expect(summarizeMeasurements(samples, 0, 5000)).toMatchObject({
      complete: false,
      gapCount: 1,
    });
    expect(
      summarizeMeasurements(
        samples.map((row) => Object.assign({}, row, { atMs: row.atMs + 4000 })),
        0,
        5000,
      ).complete,
    ).toBe(false);
  });
});

function fixture(
  options: {
    fail?: "prepare" | "test" | "reader" | "cleanup";
    measure?: boolean;
    invalidMeasurement?: boolean;
    cancel?: boolean;
  } = {},
) {
  let time = 0;
  const abort = new AbortController();
  const trace: string[] = [];
  let wake: (() => void) | undefined;
  const deps: TrialDependencies = {
    signal: abort.signal,
    now: () => time,
    measure: options.measure ?? false,
    wait: (_ms, signal) =>
      new Promise<void>((resolve, reject) => {
        wake = () => {
          time += 1000;
          resolve();
        };
        signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
      }),
    create: vi.fn(async (arm, index) => {
      trace.push(`create:${index}:${arm}`);
      return {
        prepare: async () => {
          trace.push(`prepare:${index}`);
          time += 100;
          if (index === 1 && options.fail === "prepare") {
            throw new Error("private preparation diagnostics");
          }
        },
        test: async (test: TestIdentity) => {
          trace.push(`test:${index}:${test}`);
          if (options.measure && !options.invalidMeasurement) {
            wake?.();
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
          }
          time += 10;
          if (options.cancel) {
            abort.abort();
          }
          if (
            index === 1 &&
            (options.fail === "test" ||
              (options.fail === "reader" && test === IOS_RELEASE_TESTS[1]))
          ) {
            throw Object.assign(new Error("private timeout diagnostics"), { code: "ETIMEDOUT" });
          }
          return result(test);
        },
        measure: async () => {
          trace.push(`measure:${index}`);
          return options.invalidMeasurement ? {} : { processes: 80, bytes: 1024, cpu: 1 };
        },
        cleanup: async () => {
          trace.push(`cleanup:${index}`);
          time += 5;
          if (options.fail === "cleanup") {
            throw new Error("private cleanup diagnostics");
          }
        },
      };
    }),
  };
  return { deps, trace };
}

describe("fresh trial ownership", () => {
  it("uses a real provider-enabled Gateway and only live-test runner env", () => {
    expect(gatewayEnv).toMatchObject({
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_CHANNELS: "0",
      OPENCLAW_SKIP_PROVIDERS: "0",
    });
    expect(MODEL_REF).toBe("openai/ios-e2e");
    expect(testRunnerEnv("synthetic-setup-code")).toEqual({
      TEST_RUNNER_OPENCLAW_IOS_LIVE_GATEWAY: "1",
      TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE: "synthetic-setup-code",
    });
  });
  it("runs live pairing and the independent reader test on one prepared simulator", async () => {
    const { deps, trace } = fixture();
    const report = await runTrials("stock", deps);
    expect(report.complete).toBe(true);
    expect(report.trials).toEqual([
      expect.objectContaining({
        status: "passed",
        tests: IOS_RELEASE_TESTS.map((test) => ({ test, status: "passed", ms: 10 })),
        preparationMs: 100,
        testMs: 20,
        totalMs: 125,
      }),
    ]);
    expect(deps.create).toHaveBeenCalledExactlyOnceWith("stock", 1);
    expect(trace).toEqual([
      "create:1:stock",
      "prepare:1",
      ...IOS_RELEASE_TESTS.map((test) => `test:1:${test}`),
      "cleanup:1",
    ]);
  });
  it("retains all eight fresh arms in fixed AB BA AB BA order after a failed arm", async () => {
    const { deps, trace } = fixture({ fail: "test", measure: true });
    const report = await runTrials("compare", deps);
    const order = ["stock", "simslim", "simslim", "stock", "stock", "simslim", "simslim", "stock"];
    expect(armPlan("compare").map(({ arm }) => arm)).toEqual(order);
    expect(report.trials.map(({ arm }) => arm)).toEqual(order);
    expect(deps.create).toHaveBeenCalledTimes(8);
    expect(report.trials[0]).toMatchObject({
      status: "failed",
      errors: ["test-timeout"],
      tests: [{ test: IOS_RELEASE_TESTS[0], status: "failed" }],
    });
    expect(
      report.trials
        .slice(1)
        .every((trial) => trial.status === "passed" && trial.tests.length === 2),
    ).toBe(true);
    expect(trace.filter((entry) => entry.startsWith("cleanup:"))).toHaveLength(8);
    for (let index = 1; index < 8; index++) {
      expect(trace.indexOf(`cleanup:${index}`)).toBeLessThan(trace.indexOf(`prepare:${index + 1}`));
    }
    expect(JSON.stringify(report)).not.toContain("private");
  });
  it.each(["test", "reader"] as const)(
    "fails the arm after its %s failure without repeating either test",
    async (fail) => {
      const { deps, trace } = fixture({ fail });
      const report = await runTrials("stock", deps);
      expect(report.trials).toHaveLength(1);
      expect(report.trials[0]).toMatchObject({
        status: "failed",
        errors: ["test-timeout"],
        tests:
          fail === "test"
            ? [{ test: IOS_RELEASE_TESTS[0], status: "failed" }]
            : [
                { test: IOS_RELEASE_TESTS[0], status: "passed" },
                { test: IOS_RELEASE_TESTS[1], status: "failed" },
              ],
      });
      expect(trace.filter((entry) => entry.startsWith("test:"))).toEqual(
        (fail === "test" ? [IOS_RELEASE_TESTS[0]] : IOS_RELEASE_TESTS).map(
          (test) => `test:1:${test}`,
        ),
      );
      expect(trace.at(-1)).toBe("cleanup:1");
    },
  );
  it("refuses comparison without a meter", async () => {
    const { deps } = fixture();
    await expect(runTrials("compare", deps)).rejects.toThrow("comparison-meter-required");
    expect(deps.create).not.toHaveBeenCalled();
  });
  it("does not retry failed preparation or start its test/meter", async () => {
    const { deps, trace } = fixture({ fail: "prepare" });
    const report = await runTrials("stock", deps);
    expect(report.trials[0]?.errors).toEqual(["preparation-failed"]);
    expect(trace.filter((entry) => entry === "prepare:1")).toHaveLength(1);
    expect(trace.some((entry) => entry.startsWith("test:"))).toBe(false);
    expect(report.trials[0]?.tests).toEqual([]);
    expect(trace).toContain("cleanup:1");
  });
  it("joins the collector and fails incomplete measurement without discarding the trial", async () => {
    const { deps, trace } = fixture({ measure: true, invalidMeasurement: true });
    const report = await runTrials("stock", deps);
    expect(report.trials[0]).toMatchObject({
      status: "failed",
      measurement: { errors: 1, complete: false },
    });
    expect(trace.indexOf("prepare:1")).toBeLessThan(trace.indexOf("measure:1"));
    expect(trace.indexOf("measure:1")).toBeLessThan(trace.indexOf("cleanup:1"));
  });
  it("stops after unconfirmed cleanup or cancellation, retaining the failed run", async () => {
    for (const options of [{ fail: "cleanup" as const }, { cancel: true }]) {
      const { deps, trace } = fixture(options);
      const report = await runTrials("stock", deps);
      expect(report.complete).toBe(false);
      expect(report.trials).toHaveLength(1);
      expect(report.trials[0]?.status).toBe("failed");
      expect(trace).toContain("cleanup:1");
      if ("cancel" in options && options.cancel) {
        expect(trace.filter((entry) => entry.startsWith("test:"))).toEqual([
          `test:1:${IOS_RELEASE_TESTS[0]}`,
        ]);
      }
    }
  });
});

describe("release qualification workflow authority", () => {
  const workflow = parse(readFileSync(".github/workflows/ios-release-e2e.yml", "utf8"));
  const release = parse(readFileSync(".github/workflows/ios-release.yml", "utf8"));
  const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  it.each([
    ["manual current revision", {}, true],
    ["CI current revision", { caller: "ci" }, true],
    ["manual arbitrary target", { target: "b".repeat(40) }, false],
    ["CI arbitrary target", { caller: "ci", target: "b".repeat(40) }, false],
    ["invalid SHA", { target: "main" }, false],
    ["invalid mode", { mode: "unknown" }, false],
  ])("checks %s before checkout", (_name, options, admitted) => {
    const root = tempDirs.make("ios-e2e-workflow-authority-");
    const output = path.join(root, "outputs");
    const sha = "a".repeat(40);
    const target = "target" in options ? options.target : sha;
    const repository = "openclaw/openclaw";
    const ref = "refs/heads/main";
    const caller = "caller" in options ? options.caller : "ios-release-e2e";
    const first = workflow.jobs.qualify.steps[0];
    expect(first.id).toBe("start");
    const execution = spawnSync("/bin/bash", ["-c", first.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_ENV: path.join(root, "env"),
        GITHUB_OUTPUT: output,
        GITHUB_SHA: sha,
        GITHUB_REPOSITORY: repository,
        GITHUB_REF: ref,
        GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/${caller}.yml@${ref}`,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        TARGET_SHA: target,
        E2E_MODE: "mode" in options ? options.mode : "stock",
      },
    });
    expect(execution.status === 0).toBe(admitted);
    const proof = JSON.parse(readFileSync(path.join(root, "ios-release-e2e-proof.json"), "utf8"));
    expect(proof).toMatchObject({
      status: "failed",
      trials: [],
    });
  });
  it("isolates qualification builds from the release checkout before accessing signing assets", () => {
    const releaseJob = release.jobs.release;
    const qualification = release.jobs[releaseJob.needs];
    expect(qualification).toMatchObject({
      uses: "./.github/workflows/ios-release-e2e.yml",
      permissions: { contents: "read" },
      with: { target_sha: "${{ github.sha }}", mode: "stock" },
    });
    expect(qualification.if).toBe(releaseJob.if);
    expect(qualification.secrets).toBeUndefined();
    expect(qualification["continue-on-error"]).toBeUndefined();
    expect(releaseJob["continue-on-error"]).toBeUndefined();
    expect(releaseJob.if).not.toMatch(/\b(?:always|failure|cancelled)\s*\(/u);

    const steps = releaseJob.steps;
    expect(
      steps.some((step: { run?: string }) => step.run?.includes("scripts/ios-release-e2e.ts")),
    ).toBe(false);
    const signing = steps.findIndex(
      (step: { name: string }) => step.name === "Create apps-signing read token",
    );
    const upload = steps.findIndex(
      (step: { name: string }) => step.name === "Prepare and upload iOS release",
    );
    expect(signing).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(signing);
    for (const step of [steps[signing], steps[upload]]) {
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    }
    const recovery = steps.find(
      (step: { name: string }) => step.name === "Retain release plan and notes",
    );
    for (const outcome of ["skipped", "success", "failure", "cancelled"] as const) {
      expect(
        evaluateWorkflowExpression(`\${{ ${recovery.if} }}`, {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          failed: true,
          steps: { [steps[upload].id]: { outputs: {}, outcome } },
        }),
      ).toBe(outcome !== "skipped");
    }
    expect(recovery.with["if-no-files-found"]).toBe("error");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.qualify["runs-on"]).toBe("xcode-27-xlarge");
    expect(workflow.jobs.qualify.environment).toBeUndefined();
    expect(workflow.on.workflow_dispatch.inputs.target_sha).toBeUndefined();
    expect(workflow.jobs.qualify.env.TARGET_SHA).toBe("${{ inputs.target_sha || github.sha }}");
  });
  it("fails missing target harnesses and uses a step-scoped compare binary", () => {
    const steps = workflow.jobs.qualify.steps;
    const checkout = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout.with.ref).toBe("${{ github.sha }}");
    expect(checkout.with["persist-credentials"]).toBe(false);
    const verify = steps.find((step: { name: string }) => step.name.startsWith("Verify target"));
    expect(verify.run).toContain('[[ "$(git rev-parse HEAD)" == "$TARGET_SHA" ]]');
    expect(verify.run).toContain("test -f scripts/ios-release-e2e.ts");
    expect(verify.if).toBeUndefined();
    expect(workflow.jobs.qualify.env.OPENCLAW_CI_SIMSLIM_BINARY).toBeUndefined();
    const upload = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(upload.if).toBe("always()");
    expect(upload.with.path).toBe("${{ runner.temp }}/ios-release-e2e-proof.json");
  });
  it.each([
    ["full", "a".repeat(40), true],
    ["full", "b".repeat(40), false],
    ["main", "a".repeat(40), false],
    ["main", "b".repeat(40), false],
  ])(
    "selects %s-tier target %s for required native qualification: %s",
    (tier, target, selected) => {
      const job = ci.jobs["ios-release-e2e"];
      expect(
        evaluateWorkflowExpression(job.if, {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          sha: "a".repeat(40),
          preflightOutputs: {
            validation_tier: tier,
            checkout_revision: target,
            release_scope: "full",
            compatibility_target: "false",
            run_ios_build: "true",
          },
        }),
      ).toBe(selected);
      expect(job.with.target_sha).toBe("${{ needs.preflight.outputs.checkout_revision }}");
      expect(ci.jobs["ci-gate"].needs).toContain("ios-release-e2e");
      const gate = ci.jobs["ci-gate"].steps.find(
        (step: { name: string }) => step.name === "Verify selected CI lanes",
      );
      expect(gate.env.JOB_RESULTS).toContain(
        `ios-release-e2e=\${{ needs.ios-release-e2e.result }}|${job.if}`,
      );
    },
  );
});

describe("native command adapter", () => {
  it.each([
    "success",
    "dirty-tracked",
    "dirty-untracked",
    "source-late-dirty",
    "source-late-head-change",
    "different-xcode",
    "different-xcode-build",
    "invalid-xcode-output",
    "different-runtime",
    "newest-compatible-runtime",
    "unavailable-runtime",
    "unsupported-runtime-device",
    "unsupported-runtime-architecture",
    "non-ios-runtime",
    "cleanup-failure",
    "build-unjoined",
    "build-exit",
    "boot-timeout",
    "gateway-start-failure",
    "setup-code-timeout",
    "setup-code-rpc-timeout",
    "test-unjoined",
    "test-exit",
    "reader-failure",
    "fixture-exit",
    "gateway-exit",
    "missing-first",
    "missing-second",
    "missing-relaunch",
    "provider-duplicate",
    "provider-out-of-order",
    "provider-extra",
    "test-timeout-output",
    "reply-failure-evidence",
    "reply-failure-history-error",
    "reply-failure-submission",
    "reply-failure-source-only",
    "reply-failure-app-log-error",
  ])("owns admission, build, test and cleanup for %s", async (scenario) => {
    const temp = tempDirs.make("ios-release-e2e-adapter-");
    const developerDir = tempDirs.make("ios-release-e2e-developer-");
    vi.spyOn(os, "tmpdir").mockReturnValue(temp);
    vi.stubGlobal(
      "process",
      Object.defineProperties(Object.create(process), {
        platform: { value: "darwin" },
        arch: { value: "arm64" },
      }),
    );
    vi.stubEnv("OPENCLAW_CI_SIMSLIM_BINARY", "");
    const instances: { cleanup: ReturnType<typeof vi.fn> }[] = [];
    const lifecycle: string[] = [];
    let simulatorReady = false;
    let sourceChanged = false;
    let exitMock: (() => void) | undefined;
    let requestLog = "";
    let xctestrunPath = "";
    nativeMocks.build.mockImplementation(async (options) => {
      const derivedDataPath = path.join(options.buildDir, "DerivedData");
      xctestrunPath = path.join(derivedDataPath, "Build/Products/OpenClawUITests.xctestrun");
      await options.build(derivedDataPath);
      return { derivedDataPath, xctestrunPath, reused: false };
    });
    const gatewayChild: EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    } = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    let nativeCommandActive = false;
    let historyReadBeforeCommandExit = false;
    nativeMocks.rpc.mockImplementation(async (options) => {
      if (options.method === "chat.history") {
        historyReadBeforeCommandExit = nativeCommandActive;
        if (scenario === "reply-failure-history-error") {
          throw new Error("private history failure");
        }
        return {
          messages: [
            { role: "user", content: [{ type: "text", text: "OPENCLAW_E2E_RELAUNCH" }] },
            { role: "assistant", content: [{ type: "text", text: "OPENCLAW_E2E_FIRST" }] },
          ],
        };
      }
      lifecycle.push("setup-code");
      options.onHelloOk?.();
      options.assertDispatchCurrent?.();
      if (scenario === "setup-code-timeout") {
        throw new Error("private fixture command failed", {
          cause: Object.assign(new Error("private setup code and path"), { code: "ETIMEDOUT" }),
        });
      }
      if (scenario === "setup-code-rpc-timeout") {
        throw new GatewayTransportError({
          kind: "timeout",
          message: "private RPC timeout",
          connectionDetails: { url: "ws://private", urlSource: "private", message: "private" },
          timeoutMs: 30_000,
        });
      }
      return { setupCode: `synthetic-code-${instances.length}` };
    });
    nativeMocks.gateway.mockImplementation(async () => {
      expect(simulatorReady).toBe(true);
      lifecycle.push("gateway-create");
      const index = instances.length + 1;
      const instance = {
        url: `ws://127.0.0.1:${20000 + index}`,
        gatewayToken: `synthetic-token-${index}`,
        configPath: `/private/fixture-${index}/config.json`,
        child: gatewayChild,
        startGateway: vi.fn(async () => {
          lifecycle.push("gateway-start");
          if (scenario === "gateway-start-failure") {
            throw new Error("private Gateway startup failure");
          }
        }),
        logs: () => "private log\n[responses] start private\n[responses] completed private\n",
        cleanup: vi.fn(async () => {
          lifecycle.push("gateway-cleanup");
          gatewayChild.exitCode = 0;
          gatewayChild.emit("exit", 0, null);
          if (scenario === "cleanup-failure") {
            throw new Error("private cleanup failure");
          }
        }),
      };
      instances.push(instance);
      return instance;
    });
    let created = 0;
    let appContainer = "";
    let selectedTest: string = IOS_RELEASE_TESTS[0];
    let joinedMocks = 0;
    nativeMocks.command.mockImplementation(async (options) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      options.onReady?.({ stdout, stderr } as unknown as ChildProcess);
      const args = options.args as string[];
      if (args.includes("scripts/e2e/mock-openai-server.mjs")) {
        expect(simulatorReady).toBe(true);
        lifecycle.push("mock-start");
        requestLog = options.env.MOCK_REQUEST_LOG;
        stdout.write("mock-openai listening on 20001\n");
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            joinedMocks++;
            lifecycle.push("mock-cleanup");
            reject(Object.assign(new Error("stopped"), { code: "ABORT_ERR" }));
          };
          exitMock = () => {
            options.signal.removeEventListener("abort", onAbort);
            joinedMocks++;
            lifecycle.push("mock-exit");
            resolve();
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
        });
      } else if (args[0] === "status") {
        expect(args).toEqual(["status", "--porcelain=v1", "--untracked-files=all"]);
        if (scenario === "dirty-tracked" || (scenario === "source-late-dirty" && sourceChanged)) {
          stdout.write(" M scripts/ios-release-e2e.ts\n");
        } else if (scenario === "dirty-untracked") {
          stdout.write("?? untracked-source.ts\n");
        }
      } else if (options.bin === "git") {
        stdout.write(
          (scenario === "source-late-head-change" && sourceChanged ? "2" : "1").repeat(40),
        );
      } else if (args.includes("-version")) {
        stdout.write(
          scenario === "different-xcode"
            ? "Xcode 26.6\nBuild version 17F113\n"
            : scenario === "different-xcode-build"
              ? "Xcode 27.0\nBuild version 27A000\n"
              : scenario === "invalid-xcode-output"
                ? "unrecognized toolchain\n"
                : "Xcode 27.0\nBuild version 27A266a\n",
        );
      } else if (args.includes("--print-path")) {
        stdout.write(`${developerDir}\n`);
      } else if (args.includes("--show-sdk-build-version")) {
        stdout.write("27.0\n");
      } else if (args.includes("runtimes")) {
        const runtime = {
          isAvailable: scenario !== "unavailable-runtime",
          version: scenario === "different-runtime" ? "27.0" : "26.5",
          identifier:
            scenario === "different-runtime"
              ? "com.apple.CoreSimulator.SimRuntime.iOS-27-0"
              : scenario === "non-ios-runtime"
                ? "com.apple.CoreSimulator.SimRuntime.watchOS-26-5"
                : "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
          supportedArchitectures:
            scenario === "unsupported-runtime-architecture" ? ["x86_64"] : ["arm64"],
          supportedDeviceTypes: [
            {
              identifier:
                scenario === "unsupported-runtime-device"
                  ? "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
                  : "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
            },
          ],
        };
        stdout.write(
          JSON.stringify({
            runtimes:
              scenario === "newest-compatible-runtime"
                ? [
                    {
                      ...runtime,
                      version: "26.9",
                      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-9",
                    },
                    { ...runtime, version: "28.0", isAvailable: false },
                    {
                      ...runtime,
                      version: "29.0",
                      identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-29-0",
                    },
                    { ...runtime, version: "30.0", supportedDeviceTypes: [] },
                    { ...runtime, version: "31.0", supportedArchitectures: ["x86_64"] },
                    runtime,
                    {
                      ...runtime,
                      version: "26.10",
                      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-10",
                    },
                  ]
                : [runtime],
          }),
        );
      } else if (args.includes("create")) {
        expect(args.at(-1)).toBe(
          scenario === "different-runtime"
            ? "com.apple.CoreSimulator.SimRuntime.iOS-27-0"
            : scenario === "newest-compatible-runtime"
              ? "com.apple.CoreSimulator.SimRuntime.iOS-26-10"
              : "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        );
        stdout.write(`11111111-2222-3333-4444-${String(++created).padStart(12, "0")}`);
      } else if (args.includes("bootstatus")) {
        lifecycle.push("boot-wait");
        await Promise.resolve();
        if (scenario === "boot-timeout") {
          throw Object.assign(new Error("private simulator boot timeout"), { code: "ETIMEDOUT" });
        }
        simulatorReady = true;
        lifecycle.push("boot-ready");
      } else if (args.includes("delete")) {
        lifecycle.push("simulator-delete");
      } else if (args.includes("build-for-testing")) {
        appContainer = path.join(
          path.dirname(args[args.indexOf("-derivedDataPath") + 1]!),
          "app-container",
        );
        if (scenario === "build-unjoined") {
          throw Object.assign(new Error("private build termination failure"), {
            code: "ETIMEDOUT",
            processTreeState: "live",
          });
        }
        if (scenario === "build-exit") {
          stderr.write("BUILD FAILED: private setup code and private path\n");
          return 65;
        }
      } else if (args.includes("test-without-building")) {
        const testArgument = args.find((arg) => arg.startsWith("-only-testing:"));
        if (!testArgument) {
          throw new Error("native test selection missing");
        }
        selectedTest = testArgument.slice("-only-testing:".length);
        const reader = selectedTest === IOS_RELEASE_TESTS[1];
        lifecycle.push(reader ? "reader-test" : "live-test");
        if (!reader) {
          stdout.write(
            "IOS_RELEASE_CHECKPOINT paired\nIOS_RELEASE_CHECKPOINT private-credential\n",
          );
        }
        if (reader) {
          expect(instances[0]?.cleanup).toHaveBeenCalledOnce();
          expect(joinedMocks).toBe(1);
          expect(options.env.TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE).toBe("");
          expect(options.env.TEST_RUNNER_OPENCLAW_IOS_LIVE_GATEWAY).not.toBe("1");
          if (scenario === "reader-failure") {
            return 65;
          }
        } else {
          const stages =
            scenario === "provider-duplicate"
              ? ["first", "first", "second", "relaunch"]
              : scenario === "provider-out-of-order"
                ? ["second", "first", "relaunch"]
                : [
                    "first",
                    "second",
                    "relaunch",
                    ...(scenario === "provider-extra" ? ["unexpected"] : []),
                  ];
          const requests = scenario.startsWith("reply-failure-")
            ? [
                {
                  model: "ios-e2e",
                  input: [
                    {
                      role: "user",
                      content: "Reply exactly with OPENCLAW_E2E_RELAUNCH and no other text.",
                    },
                  ],
                  metadata: { title: "OPENCLAW_E2E_FIRST" },
                },
                { model: "ios-e2e" },
              ]
            : stages.map((stage) => {
                const marker = `OPENCLAW_E2E_${stage.toUpperCase()}`;
                const missing = scenario === `missing-${stage}`;
                return {
                  model: "ios-e2e",
                  input: [
                    { role: "user", content: `Reply exactly with ${marker} and no other text.` },
                    { role: "assistant", content: marker },
                    {
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text:
                            "[Sun 2026-09-27 21:02 CDT] " +
                            "Conversation info: ⟦openclaw:ctx⟧\n```json\n" +
                            JSON.stringify({ sender: { id: "fixture-owner", name: marker } }) +
                            "\n```\n\n" +
                            (missing
                              ? "No requested marker here."
                              : `Reply exactly with ${marker} and no other text.`),
                        },
                      ],
                    },
                    {
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text:
                            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" +
                            "OPENCLAW_E2E_FIRST\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
                        },
                      ],
                    },
                  ],
                  metadata: { title: marker },
                };
              });
          writeFileSync(
            requestLog,
            requests
              .map((body) => JSON.stringify({ path: "/v1/responses", body: JSON.stringify(body) }))
              .join("\n") + "\n",
          );
        }
        if (scenario === "gateway-exit") {
          gatewayChild.exitCode = 17;
          gatewayChild.emit("exit", 17, null);
          expect(options.signal.aborted).toBe(true);
          throw Object.assign(new Error("private native command interrupted"), {
            code: "ABORT_ERR",
          });
        }
        if (scenario === "fixture-exit") {
          exitMock?.();
          await Promise.resolve();
        }
        if (
          scenario.startsWith("reply-failure-") &&
          args.includes(`-only-testing:${IOS_RELEASE_TESTS[0]}`)
        ) {
          nativeCommandActive = true;
          const failureMessage =
            scenario === "reply-failure-source-only"
              ? ""
              : `IOS_RELEASE_CHAT_FAILURE relaunch ${scenario === "reply-failure-submission" ? "submission" : "reply"} draft=false keyboard=true reply=false writing=false jump=true foreground=true input=true transcript=true send=false`;
          stdout.write(
            "Test Case '-[OpenClawUITests.OpenClawSnapshotUITests testLiveGatewayPairChatAndRelaunch]' started.\n" +
              `/private/checkout/OpenClawSnapshotUITests.swift:1913: error: private ${failureMessage}\n` +
              "Test Case '-[OpenClawUITests.OpenClawSnapshotUITests testLiveGatewayPairChatAndRelaunch]' failed (99 seconds).\n",
          );
          await Promise.resolve();
          nativeCommandActive = false;
          throw Object.assign(new Error("private timeout diagnostics"), { code: "ETIMEDOUT" });
        }
        if (scenario === "test-timeout-output") {
          stdout.write(
            "Test Case '-[OpenClawUITests.OpenClawSnapshotUITests testLiveGatewayPairChatAndRelaunch]' started.\n" +
              "/private/checkout/OpenClawSnapshotUITests.swift:1904: error: private assertion details\n" +
              "/private/checkout/OpenClawSnapshotUITests.swift:1904: error: repeated private details\n" +
              "/private/Other.swift:42: error: private details\n" +
              "Test Case '-[OpenClawUITests.OpenClawSnapshotUITests testLiveGatewayPairChatAndRelaunch]' failed (39.615 seconds).\n",
          );
          throw Object.assign(new Error("private timeout diagnostics"), { code: "ETIMEDOUT" });
        }
        if (scenario === "test-unjoined") {
          throw Object.assign(new Error("private test termination failure"), {
            code: "ETIMEDOUT",
            processTreeState: "unknown",
          });
        }
        if (scenario === "test-exit") {
          stdout.write(
            "/private/checkout/OpenClawSnapshotUITests.swift:1904: error: private assertion details\n" +
              "private teardown details\n".repeat(256),
          );
          stderr.write("TEST FAILED: private setup code and private path\n");
          return 65;
        }
        if (!reader) {
          stdout.write("IOS_RELEASE_CHECKPOINT overview\n");
        }
      } else if (options.bin === "/usr/bin/plutil") {
        stdout.write("ai.synthetic.private\n");
      } else if (args.includes("get_app_container")) {
        expect(args).toEqual([
          "simctl",
          "get_app_container",
          "11111111-2222-3333-4444-000000000001",
          "ai.synthetic.private",
          "data",
        ]);
        expect(options.timeoutMs).toBe(5_000);
        if (scenario === "reply-failure-app-log-error") {
          throw new Error("private app container failure");
        }
        mkdirSync(path.join(appContainer, "Library/Caches"), { recursive: true });
        writeFileSync(
          path.join(appContainer, "Library/Caches/openclaw-gateway.log"),
          "[2026-09-26T00:00:00Z] chat.ui send invoked sessionKey=private inputLen=100\n" +
            "[2026-09-26T00:00:00Z] chat.ui send queued sessionKey=private localRunId=private\n" +
            "[2026-09-26T00:00:00Z] chat.ui transport send start sessionKey=private\n" +
            "[2026-09-26T00:00:00Z] chat.ui send failed sessionKey=private error=private\n" +
            "[2026-09-26T00:00:00Z] chat.send skipped before dispatch: route changed\n" +
            "[2026-09-26T00:00:00Z] unknown event private credential\n",
        );
        stdout.write(appContainer);
      } else if (args.includes("xcresulttool")) {
        stdout.write(JSON.stringify(result(selectedTest)));
      }
      return 0;
    });
    const proof: Record<string, unknown> = {};
    const progressSnapshots: string[] = [];
    const admission = createNativeDependencies({
      mode: "stock",
      targetSha: "1".repeat(40),
      signal: new AbortController().signal,
      proof,
      onProgress: async () => {
        progressSnapshots.push(JSON.stringify(proof));
      },
    });
    if (scenario.startsWith("dirty-")) {
      await expect(admission).rejects.toMatchObject({
        diagnostic: { operation: "source-status", code: "dirty-source" },
      });
      expect(nativeMocks.command.mock.calls).toHaveLength(2);
      expect(readdirSync(temp)).toEqual([]);
      return;
    }
    if (
      [
        "unavailable-runtime",
        "unsupported-runtime-device",
        "unsupported-runtime-architecture",
        "non-ios-runtime",
        "invalid-xcode-output",
      ].includes(scenario)
    ) {
      await expect(admission).rejects.toMatchObject({
        diagnostic:
          scenario === "invalid-xcode-output"
            ? { operation: "xcode-version", code: "failed" }
            : { operation: "simulator-runtime", code: "not-found" },
      });
      expect(
        nativeMocks.command.mock.calls.some(([{ args }]) => args.includes("build-for-testing")),
      ).toBe(false);
      expect(readdirSync(temp)).toEqual([]);
      return;
    }
    if (scenario.startsWith("build-")) {
      await expect(admission).rejects.toMatchObject({
        diagnostic:
          scenario === "build-unjoined"
            ? { operation: "native-build", code: "timeout", errorCode: "ETIMEDOUT" }
            : { operation: "native-build", code: "exit", exitCode: 65, context: ["build-failed"] },
      });
      expect(readdirSync(temp)).toHaveLength(scenario === "build-unjoined" ? 1 : 0);
      expect(proof.resourcesPreserved).toBe(scenario === "build-unjoined" ? true : undefined);
      return;
    }
    const native = await admission;
    expect(proof).toMatchObject({
      xcode: scenario === "different-xcode" ? "26.6" : "27.0",
      xcodeBuild:
        scenario === "different-xcode"
          ? "17F113"
          : scenario === "different-xcode-build"
            ? "27A000"
            : "27A266a",
      runtime:
        scenario === "different-runtime"
          ? "27.0"
          : scenario === "newest-compatible-runtime"
            ? "26.10"
            : "26.5",
      runtimeIdentifier:
        scenario === "different-runtime"
          ? "com.apple.CoreSimulator.SimRuntime.iOS-27-0"
          : scenario === "newest-compatible-runtime"
            ? "com.apple.CoreSimulator.SimRuntime.iOS-26-10"
            : "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    });
    try {
      const report = await runTrials("stock", native.dependencies);
      expect(JSON.stringify(proof)).not.toMatch(/private|synthetic|OPENCLAW_E2E_|metadata/);
      expect(progressSnapshots.length).toBeGreaterThan(0);
      expect(progressSnapshots.join("\n")).not.toMatch(/private|synthetic|OPENCLAW_E2E_|metadata/);
      if (scenario.startsWith("reply-failure-")) {
        expect(report.complete).toBe(true);
        expect(report.trials.map((trial) => trial.status)).toEqual(["failed"]);
        expect(report.trials[0]).toMatchObject({
          errors: ["test-timeout"],
          diagnostics: [{ operation: "native-test", code: "timeout", errorCode: "ETIMEDOUT" }],
        });
        const context = report.trials[0]?.diagnostics[0]?.context;
        expect(context).toEqual(
          expect.arrayContaining([
            ...(scenario === "reply-failure-source-only"
              ? []
              : [
                  "chat-stage:relaunch",
                  `chat-checkpoint:${scenario === "reply-failure-submission" ? "submission" : "reply"}`,
                  "chat-draft-retained:false",
                  "chat-keyboard:true",
                  "chat-reply-present:false",
                  "chat-writing:false",
                  "chat-jump:true",
                  "chat-app-foreground:true",
                  "chat-input-present:true",
                  "chat-transcript-present:true",
                  "chat-send-present:false",
                ]),
            "provider-latest-user:relaunch",
            "provider-body-tail:first",
            "provider-marker-match:false",
            "model-any-request-stage:start",
            "model-any-request-stage:completed",
            expect.stringMatching(/^failure-evidence-at-ms:\d+$/),
            ...(scenario === "reply-failure-app-log-error"
              ? ["app-evidence-unavailable"]
              : [
                  "app-evidence-read",
                  "app-send-stage:invoked",
                  "app-send-stage:optimistic-message",
                  "app-send-stage:transport-start",
                  "app-send-stage:failed",
                  "app-send-stage:dispatch-route-changed",
                ]),
            ...(scenario === "reply-failure-history-error"
              ? ["history-evidence-unavailable"]
              : ["history-user:relaunch", "history-assistant:first"]),
          ]),
        );
        expect(context).not.toContain("provider-marker-match:true");
        expect(context).not.toContain("app-send-stage:transport-accepted");
        expect(historyReadBeforeCommandExit).toBe(true);
        expect(instances.every((instance) => instance.cleanup.mock.calls.length === 1)).toBe(true);
        expect(JSON.stringify(report)).not.toMatch(/private|OPENCLAW_E2E_|metadata/);
        return;
      }
      if (scenario === "test-timeout-output") {
        expect(report.complete).toBe(true);
        for (const trial of report.trials) {
          expect(trial).toMatchObject({
            status: "failed",
            errors: ["test-timeout"],
            diagnostics: [
              {
                operation: "native-test",
                code: "timeout",
                errorCode: "ETIMEDOUT",
                context: expect.arrayContaining([
                  "xctest-started",
                  "xctest-failed",
                  "xctest-line:1904",
                ]),
              },
            ],
          });
        }
        expect(instances.every((instance) => instance.cleanup.mock.calls.length === 1)).toBe(true);
        expect(JSON.stringify(report)).not.toContain("private");
        return;
      }
      if (scenario === "boot-timeout" || scenario === "gateway-start-failure") {
        expect(report.trials).toMatchObject([
          {
            status: "failed",
            tests: [],
            errors: [scenario === "boot-timeout" ? "preparation-timeout" : "preparation-failed"],
            diagnostics: [
              {
                operation: scenario === "boot-timeout" ? "simulator-ready" : "gateway-start",
                code: scenario === "boot-timeout" ? "timeout" : "failed",
              },
            ],
          },
        ]);
        expect(lifecycle).not.toContain("live-test");
        expect(lifecycle).not.toContain("setup-code");
        if (scenario === "boot-timeout") {
          expect(nativeMocks.gateway).not.toHaveBeenCalled();
          expect(lifecycle).not.toContain("mock-start");
        }
        expect(lifecycle.at(-1)).toBe("simulator-delete");
        return;
      }
      if (
        scenario.startsWith("missing-") ||
        scenario.startsWith("provider-") ||
        scenario === "fixture-exit" ||
        scenario === "gateway-exit"
      ) {
        expect(report.trials).toMatchObject([
          {
            status: "failed",
            tests: [{ test: IOS_RELEASE_TESTS[0], status: "failed" }],
            errors: ["test-failed"],
            diagnostics: [
              {
                operation:
                  scenario === "fixture-exit"
                    ? "fixture-server"
                    : scenario === "gateway-exit"
                      ? "gateway-start"
                      : "provider-rpc",
                code: scenario === "gateway-exit" ? "exit" : "failed",
                ...(scenario === "gateway-exit" ? { exitCode: 17 } : {}),
              },
            ],
          },
        ]);
        expect(lifecycle.filter((event) => event === "live-test")).toHaveLength(1);
        expect(lifecycle).not.toContain("reader-test");
        expect(instances[0]?.cleanup).toHaveBeenCalledOnce();
        expect(joinedMocks).toBe(1);
        return;
      }
      if (scenario === "reader-failure") {
        expect(report.trials).toMatchObject([
          {
            status: "failed",
            tests: [
              { test: IOS_RELEASE_TESTS[0], status: "passed" },
              { test: IOS_RELEASE_TESTS[1], status: "failed" },
            ],
            errors: ["test-failed"],
            diagnostics: [{ operation: "native-test", code: "exit", exitCode: 65 }],
          },
        ]);
        expect(lifecycle.filter((event) => event.endsWith("-test"))).toEqual([
          "live-test",
          "reader-test",
        ]);
        expect(lifecycle.indexOf("gateway-cleanup")).toBeLessThan(lifecycle.indexOf("reader-test"));
        expect(lifecycle.indexOf("mock-cleanup")).toBeLessThan(lifecycle.indexOf("reader-test"));
        expect(instances[0]?.cleanup).toHaveBeenCalledOnce();
        return;
      }
      if (scenario === "setup-code-timeout" || scenario === "setup-code-rpc-timeout") {
        expect(report.complete).toBe(true);
        for (const trial of report.trials) {
          expect(trial).toMatchObject({
            status: "failed",
            errors: ["preparation-timeout"],
            diagnostics: [
              {
                operation: "setup-code",
                code: "timeout",
                ...(scenario === "setup-code-timeout" ? { errorCode: "ETIMEDOUT" } : {}),
                context:
                  scenario === "setup-code-rpc-timeout"
                    ? ["rpc-authenticated:true", "rpc-dispatch-entered:true"]
                    : [],
              },
            ],
          });
        }
        expect(report.trials[0]?.tests).toEqual([]);
        expect(proof.fixtures).toEqual([
          expect.objectContaining({
            trial: 1,
            setupRpc: { authenticated: true, dispatchEntered: true, responseReceived: false },
          }),
        ]);
        expect(
          nativeMocks.command.mock.calls.some(([{ args }]) =>
            args.includes("test-without-building"),
          ),
        ).toBe(false);
        expect(instances.every((instance) => instance.cleanup.mock.calls.length === 1)).toBe(true);
        expect(JSON.stringify(report)).not.toContain("private");
        return;
      }
      if (scenario === "cleanup-failure" || scenario === "test-unjoined") {
        expect(report.complete).toBe(false);
        expect(report.trials).toHaveLength(1);
        expect(report.trials[0]?.errors).toContain("cleanup-failed");
        expect(proof.resourcesPreserved).toBe(true);
        return;
      }
      if (scenario === "test-exit") {
        expect(report.trials.map((trial) => trial.status)).toEqual(["failed"]);
        expect(report.trials[0]?.diagnostics).toEqual([
          {
            operation: "native-test",
            code: "exit",
            exitCode: 65,
            context: expect.arrayContaining(["test-failed", "xctest-line:1904"]),
          },
        ]);
        expect(JSON.stringify(report)).not.toContain("private");
        return;
      }
      if (scenario === "source-late-dirty" || scenario === "source-late-head-change") {
        expect(report.trials.map((trial) => trial.status)).toEqual(["passed"]);
        expect(report.trials[0]?.tests).toHaveLength(2);
        sourceChanged = true;
        await expect(native.assertCurrentSource()).rejects.toMatchObject({
          diagnostic:
            scenario === "source-late-dirty"
              ? { operation: "source-status", code: "dirty-source" }
              : { operation: "source-head", code: "identity-mismatch" },
        });
        expect(instances[0]?.cleanup).toHaveBeenCalledOnce();
        expect(lifecycle.filter((entry) => entry.endsWith("-test"))).toEqual([
          "live-test",
          "reader-test",
        ]);
        return;
      }
      expect(report.trials.map((trial) => trial.status)).toEqual(["passed"]);
      expect(report.trials[0]?.tests.map(({ test, status }) => ({ test, status }))).toEqual(
        IOS_RELEASE_TESTS.map((test) => ({ test, status: "passed" })),
      );
      expect(lifecycle.indexOf("boot-ready")).toBeLessThan(lifecycle.indexOf("mock-start"));
      expect(lifecycle.indexOf("boot-ready")).toBeLessThan(lifecycle.indexOf("gateway-start"));
      expect(lifecycle.indexOf("gateway-start")).toBeLessThan(lifecycle.indexOf("setup-code"));
      expect(lifecycle.indexOf("setup-code")).toBeLessThan(lifecycle.indexOf("live-test"));
      expect(lifecycle.indexOf("gateway-cleanup")).toBeLessThan(lifecycle.indexOf("reader-test"));
      expect(lifecycle.indexOf("mock-cleanup")).toBeLessThan(lifecycle.indexOf("reader-test"));
      expect(lifecycle.at(-1)).toBe("simulator-delete");
      expect(created).toBe(1);
      expect(joinedMocks).toBe(1);
      for (const [index, instance] of instances.entries()) {
        expect(nativeMocks.rpc).toHaveBeenNthCalledWith(index + 1, {
          config: {},
          configPath: `/private/fixture-${index + 1}/config.json`,
          url: `ws://127.0.0.1:${20001 + index}`,
          token: `synthetic-token-${index + 1}`,
          ignoreEnvUrlOverride: true,
          deviceIdentity: null,
          sharedStateMode: "read-only",
          method: "device.pair.setupCode",
          params: { publicUrl: `ws://127.0.0.1:${20001 + index}`, includeQr: false },
          timeoutMs: 30_000,
          signal: expect.any(AbortSignal),
          onHelloOk: expect.any(Function),
          assertDispatchCurrent: expect.any(Function),
        });
        expect(instance.cleanup).toHaveBeenCalledOnce();
      }
      expect(proof.fixtures).toEqual([
        expect.objectContaining({
          trial: 1,
          cleanupConfirmed: true,
          setupRpc: { authenticated: true, dispatchEntered: true, responseReceived: true },
          providerMessages: [
            { stage: "first", received: true },
            { stage: "second", received: true },
            { stage: "relaunch", received: true },
          ],
        }),
      ]);
      expect(proof.fixtures).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ gatewayExited: true })]),
      );
      expect(gatewayChild.listenerCount("exit")).toBe(0);
      expect(proof.phases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "native-test",
            trial: 1,
            status: "passed",
            checkpoint: "overview",
          }),
        ]),
      );
      const commands = nativeMocks.command.mock.calls.map(([options]) => options);
      expect(commands.filter(({ args }) => args.includes("build-for-testing"))).toHaveLength(1);
      const nativeBuild = commands.find(({ args }) => args.includes("build-for-testing"));
      expect(nativeBuild.args).toEqual(
        expect.arrayContaining([
          "-configuration",
          "Debug",
          "CODE_SIGNING_ALLOWED=YES",
          "CODE_SIGN_IDENTITY=-",
          "CODE_SIGN_STYLE=Manual",
          "PROVISIONING_PROFILE=",
          "PROVISIONING_PROFILE_SPECIFIER=",
        ]),
      );
      expect(nativeBuild.args).not.toContain("-allowProvisioningUpdates");
      expect(nativeMocks.build).toHaveBeenCalledOnce();
      expect(nativeMocks.build.mock.calls[0]?.[0].identity).toMatchObject({
        sourceSha: "1".repeat(40),
        sdkVersion: "27.0",
        platform: "darwin",
        arch: "arm64",
      });
      expect(
        commands
          .filter(({ args }) => args.includes("test-without-building"))
          .map(({ env }) => env.TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE),
      ).toEqual(["synthetic-code-1", ""]);
      for (const { args: testArgs } of commands.filter(({ args }) =>
        args.includes("test-without-building"),
      )) {
        expect(testArgs).toContain(
          "platform=iOS Simulator,id=11111111-2222-3333-4444-000000000001",
        );
        expect(
          testArgs.slice(testArgs.indexOf("-xctestrun"), testArgs.indexOf("-xctestrun") + 2),
        ).toEqual(["-xctestrun", xctestrunPath]);
        expect(testArgs).not.toContain("-project");
        expect(testArgs).not.toContain("-derivedDataPath");
        expect(testArgs.some((argument: string) => argument.startsWith("CODE_SIGN"))).toBe(false);
        const diagnosticsIndex = testArgs.indexOf("-collect-test-diagnostics");
        expect(testArgs.slice(diagnosticsIndex, diagnosticsIndex + 2)).toEqual([
          "-collect-test-diagnostics",
          "never",
        ]);
        expect(testArgs).not.toContain("-test-iterations");
        expect(testArgs).not.toContain("-retry-tests-on-failure");
        expect(testArgs).not.toContain("-run-tests-until-failure");
      }
      expect(
        commands
          .filter(({ args }) => args.includes("xcresulttool"))
          .map(({ args }) => args.slice(0, 4)),
      ).toEqual([
        ["xcresulttool", "get", "test-results", "tests"],
        ["xcresulttool", "get", "test-results", "tests"],
      ]);
      expect(
        commands.filter(({ args }) => args.includes("delete")).map(({ args }) => args.at(-1)),
      ).toEqual(["11111111-2222-3333-4444-000000000001"]);
      expect(nativeMocks.gateway.mock.calls[0]?.[0]).toMatchObject({
        config: {
          gateway: { controlUi: { enabled: false } },
          agents: { defaults: { model: { primary: "openai/ios-e2e" } } },
        },
        env: gatewayEnv,
      });
    } finally {
      if (scenario === "cleanup-failure" || scenario === "test-unjoined") {
        // This is the outer owner's cleanup call after the trial loop has stopped.
        await expect(native.cleanup()).rejects.toMatchObject({
          diagnostic: { operation: "cleanup", code: "cleanup-unconfirmed" },
        });
        expect(readdirSync(temp)).toHaveLength(1);
      } else {
        await native.cleanup();
        expect(readdirSync(temp)).toEqual([]);
      }
    }
  });
});
