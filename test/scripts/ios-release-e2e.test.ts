import { spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  type TrialDependencies,
} from "../../scripts/ios-release-e2e.js";
import { createNativeDependencies } from "../../scripts/lib/ios-release-e2e-native.js";
import { GatewayTransportError } from "../../src/gateway/transport-error.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression } from "./ci-workflow.test-support.js";

const nativeMocks = vi.hoisted(() => ({
  command: vi.fn(),
  gateway: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("../../scripts/lib/managed-child-process.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mjs")>()),
  runManagedCommand: nativeMocks.command,
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
    ["wrong class", { nodeIdentifier: "OtherTests/testLiveGatewayFreshInstallSetupAndRelaunch()" }],
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
    fail?: "prepare" | "test" | "cleanup";
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
    create: vi.fn(async (test, arm, index) => {
      trace.push(`create:${index}:${arm}:${test}`);
      return {
        prepare: async () => {
          trace.push(`prepare:${index}`);
          time += 100;
          if (index === 1 && options.fail === "prepare") {
            throw new Error("private preparation diagnostics");
          }
        },
        test: async () => {
          trace.push(`test:${index}`);
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
          if (index === 1 && options.fail === "test") {
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
  it("runs a stock gate with fresh resources per test and no meter", async () => {
    const { deps, trace } = fixture();
    const report = await runTrials("stock", deps);
    expect(report.complete).toBe(true);
    expect(report.trials.map((trial) => trial.status)).toEqual(["passed", "passed"]);
    expect(deps.create).toHaveBeenNthCalledWith(1, IOS_RELEASE_TESTS[0], "stock", 1);
    expect(deps.create).toHaveBeenNthCalledWith(2, IOS_RELEASE_TESTS[1], "stock", 2);
    expect(trace.filter((entry) => entry.startsWith("measure:"))).toEqual([]);
    expect(trace.indexOf("cleanup:1")).toBeLessThan(trace.indexOf("prepare:2"));
  });
  it("retains all sixteen fresh trials in fixed AB BA AB BA order", async () => {
    const { deps, trace } = fixture({ fail: "test", measure: true });
    const report = await runTrials("compare", deps);
    expect(armPlan("compare").map(({ arm }) => arm)).toEqual([
      "stock",
      "simslim",
      "simslim",
      "stock",
      "stock",
      "simslim",
      "simslim",
      "stock",
    ]);
    expect(deps.create).toHaveBeenCalledTimes(16);
    expect(report.trials).toHaveLength(16);
    expect(report.trials[0]?.status).toBe("failed");
    expect(report.trials[0]?.errors).toEqual(["test-timeout"]);
    expect(report.trials.slice(1).every((trial) => trial.status === "passed")).toBe(true);
    expect(trace.filter((entry) => entry.startsWith("cleanup:"))).toHaveLength(16);
    expect(JSON.stringify(report)).not.toContain("private");
  });
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
    expect(trace).not.toContain("test:1");
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
  it("qualifies the checked-out release source before accessing signing assets", () => {
    const steps = release.jobs.release.steps;
    const qualify = steps.findIndex(
      (step: { name: string }) => step.name === "Qualify native iOS pairing and chat",
    );
    const signing = steps.findIndex(
      (step: { name: string }) => step.name === "Create apps-signing read token",
    );
    const upload = steps.findIndex(
      (step: { name: string }) => step.name === "Prepare and upload iOS release",
    );
    expect(qualify).toBeGreaterThan(-1);
    expect(signing).toBeGreaterThan(qualify);
    expect(upload).toBeGreaterThan(signing);
    expect(steps[qualify].run).toContain('--mode stock --target-sha "$(git rev-parse HEAD)"');
    for (const step of [steps[qualify], steps[signing], steps[upload]]) {
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
  it("uses ad-hoc Debug products, exact destinations and the XCTest result CLI", () => {
    const source = readFileSync("scripts/lib/ios-release-e2e-native.ts", "utf8");
    expect(source).not.toContain('"CODE_SIGNING_ALLOWED=NO"');
    expect(source).toContain('"Debug"');
    expect(source).toContain("`platform=iOS Simulator,id=${udid}`");
    expect(source).toContain('"test-without-building"');
    expect(source).toContain('"test-results"');
    expect(source).not.toContain('"--format"');
    expect(source).not.toContain("autoapprove");
  });
});

describe("native command adapter", () => {
  it.each([
    "success",
    "dirty-tracked",
    "dirty-untracked",
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
    "setup-code-timeout",
    "setup-code-rpc-timeout",
    "test-unjoined",
    "test-exit",
    "test-timeout-output",
  ])("owns admission, build, test and cleanup for %s", async (scenario) => {
    const temp = tempDirs.make("ios-release-e2e-adapter-");
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
    nativeMocks.rpc.mockImplementation(async () => {
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
      const index = instances.length + 1;
      const instance = {
        url: `ws://127.0.0.1:${20000 + index}`,
        gatewayToken: `synthetic-token-${index}`,
        configPath: `/private/fixture-${index}/config.json`,
        startGateway: vi.fn(async () => {}),
        cleanup: vi.fn(async () => {
          if (scenario === "cleanup-failure") {
            throw new Error("private cleanup failure");
          }
        }),
      };
      instances.push(instance);
      return instance;
    });
    let created = 0;
    let selectedTest: string = IOS_RELEASE_TESTS[0];
    let joinedMocks = 0;
    nativeMocks.command.mockImplementation(async (options) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      options.onReady?.({ stdout, stderr } as unknown as ChildProcess);
      const args = options.args as string[];
      if (args.includes("scripts/e2e/mock-openai-server.mjs")) {
        writeFileSync(
          options.env.MOCK_REQUEST_LOG,
          `${JSON.stringify({ path: "/v1/responses", body: JSON.stringify({ model: "ios-e2e" }) })}\n`,
        );
        stdout.write("mock-openai listening on 20001\n");
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              joinedMocks++;
              reject(Object.assign(new Error("stopped"), { code: "ABORT_ERR" }));
            },
            { once: true },
          );
        });
      } else if (args[0] === "status") {
        expect(args).toEqual(["status", "--porcelain=v1", "--untracked-files=all"]);
        if (scenario === "dirty-tracked") {
          stdout.write(" M scripts/ios-release-e2e.ts\n");
        } else if (scenario === "dirty-untracked") {
          stdout.write("?? untracked-source.ts\n");
        }
      } else if (options.bin === "git") {
        stdout.write("1".repeat(40));
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
      } else if (args.includes("build-for-testing")) {
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
        if (scenario === "test-timeout-output") {
          stdout.write(
            "Test Case '-[OpenClawUITests.OpenClawSnapshotUITests testLiveGatewayChatRoundTripAndControlOverview]' started.\n" +
              "/private/checkout/OpenClawSnapshotUITests.swift:1904: error: private assertion details\n" +
              "/private/checkout/OpenClawSnapshotUITests.swift:1904: error: repeated private details\n" +
              "/private/Other.swift:42: error: private details\n" +
              "Test Case '-[OpenClawUITests.OpenClawSnapshotUITests testLiveGatewayChatRoundTripAndControlOverview]' failed (39.615 seconds).\n",
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
        selectedTest = args
          .find((arg) => arg.startsWith("-only-testing:"))!
          .slice("-only-testing:".length);
      } else if (args.includes("xcresulttool")) {
        stdout.write(JSON.stringify(result(selectedTest)));
      }
      return 0;
    });
    const proof: Record<string, unknown> = {};
    const admission = createNativeDependencies({
      mode: "stock",
      targetSha: "1".repeat(40),
      signal: new AbortController().signal,
      proof,
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
                context: ["xctest-started", "xctest-failed", "xctest-line:1904"],
              },
            ],
          });
        }
        expect(instances.every((instance) => instance.cleanup.mock.calls.length === 1)).toBe(true);
        expect(JSON.stringify(report)).not.toContain("private");
        return;
      }
      if (scenario === "setup-code-timeout" || scenario === "setup-code-rpc-timeout") {
        expect(report.complete).toBe(true);
        for (const trial of report.trials) {
          expect(trial).toMatchObject({
            status: "failed",
            errors: ["test-timeout"],
            diagnostics: [
              {
                operation: "setup-code",
                code: "timeout",
                ...(scenario === "setup-code-timeout" ? { errorCode: "ETIMEDOUT" } : {}),
                context: [],
              },
            ],
          });
        }
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
        expect(report.trials.map((trial) => trial.status)).toEqual(["failed", "failed"]);
        expect(report.trials[0]?.diagnostics).toEqual([
          {
            operation: "native-test",
            code: "exit",
            exitCode: 65,
            context: ["test-failed", "xctest-line:1904"],
          },
        ]);
        expect(JSON.stringify(report)).not.toContain("private");
        return;
      }
      expect(report.trials.map((trial) => trial.status)).toEqual(["passed", "passed"]);
      expect(created).toBe(2);
      expect(joinedMocks).toBe(2);
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
          signal: native.dependencies.signal,
        });
        expect(instance.cleanup).toHaveBeenCalledOnce();
      }
      const commands = nativeMocks.command.mock.calls.map(([options]) => options);
      expect(commands.filter(({ args }) => args.includes("build-for-testing"))).toHaveLength(1);
      for (const { args: nativeArgs } of commands.filter(
        ({ args }) => args.includes("build-for-testing") || args.includes("test-without-building"),
      )) {
        expect(nativeArgs).toEqual(
          expect.arrayContaining([
            "CODE_SIGNING_ALLOWED=YES",
            "CODE_SIGN_IDENTITY=-",
            "CODE_SIGN_STYLE=Manual",
            "PROVISIONING_PROFILE=",
            "PROVISIONING_PROFILE_SPECIFIER=",
          ]),
        );
        expect(nativeArgs).not.toContain("-allowProvisioningUpdates");
      }
      expect(
        commands
          .filter(({ args }) => args.includes("test-without-building"))
          .map(({ env }) => env.TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE),
      ).toEqual(["synthetic-code-1", "synthetic-code-2"]);
      for (const { args: testArgs } of commands.filter(({ args }) =>
        args.includes("test-without-building"),
      )) {
        expect(testArgs).not.toContain("-test-iterations");
        expect(testArgs).not.toContain("-retry-tests-on-failure");
        expect(testArgs).not.toContain("-run-tests-until-failure");
      }
      expect(
        commands.filter(({ args }) => args.includes("delete")).map(({ args }) => args.at(-1)),
      ).toEqual(["11111111-2222-3333-4444-000000000001", "11111111-2222-3333-4444-000000000002"]);
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
