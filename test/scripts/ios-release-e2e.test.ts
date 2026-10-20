import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  type Trial,
  type TrialDependencies,
} from "../../scripts/ios-release-e2e.js";
import { createNativeDependencies } from "../../scripts/lib/ios-release-e2e-native.js";
import { ensureGatewaySupportsRequiredFeatures } from "../../src/gateway/call-required-features.js";
import { GatewayTransportError } from "../../src/gateway/transport-error.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflow, requiredWorkflowStep } from "./ci-workflow.test-support.js";

const nativeMocks = vi.hoisted(() => ({
  command: vi.fn(),
  build: vi.fn(),
  install: vi.fn(),
  gateway: vi.fn(),
  rpc: vi.fn(),
}));
const commandsWith = (argument: string) =>
  nativeMocks.command.mock.calls
    .map(([options]) => options)
    .filter(({ args }) => args.includes(argument));
const matching = (value: Record<string, unknown>) => expect.objectContaining(value);
const containing = (value: unknown[]) => expect.arrayContaining(value);
function expectBefore(events: string[], pairs: [string, string][]) {
  for (const [before, after] of pairs) {
    expect(events.indexOf(before)).toBeLessThan(events.indexOf(after));
  }
}
const prompt = (marker: string) => `Reply exactly with ${marker} and no other text.`;

function rpcTimeout(timeoutMs: number, requestDispatched?: boolean) {
  return new GatewayTransportError({
    kind: "timeout",
    message: "private RPC timeout",
    connectionDetails: { url: "ws://private", urlSource: "private", message: "private" },
    timeoutMs,
    ...(requestDispatched === undefined ? {} : { requestDispatched }),
  });
}
function commandFailure(code: "ETIMEDOUT" | "ABORT_ERR", processTreeState?: "live" | "unknown") {
  return Object.assign(new Error("private command failure"), {
    code,
    ...(processTreeState ? { processTreeState } : {}),
  });
}

function runtimeFixture(
  version = "26.5",
  options: {
    available?: boolean;
    os?: string;
    arch?: string;
    device?: string;
  } = {},
) {
  return {
    isAvailable: options.available ?? true,
    version,
    identifier: `com.apple.CoreSimulator.SimRuntime.${options.os ?? "iOS"}-${version.replaceAll(".", "-")}`,
    supportedArchitectures: [options.arch ?? "arm64"],
    supportedDeviceTypes:
      options.device === "none"
        ? []
        : [
            {
              identifier: `com.apple.CoreSimulator.SimDeviceType.${options.device ?? "iPhone-17-Pro"}`,
            },
          ],
  };
}

const userInput = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const setupPlans: Record<
  string,
  readonly [number, "success" | "timeout" | "failure" | "cancel", boolean?]
> = {
  "setup-code-rpc-timeout": [60_000, "timeout"],
  "setup-code-fast-success": [1_000, "success"],
  "setup-code-slow-success": [35_000, "success"],
  "setup-code-join-success": [11_000, "success"],
  "setup-code-join-observer-failure-success": [11_000, "success"],
  "setup-code-join-failure": [11_000, "failure"],
  "setup-code-join-cancel": [11_000, "cancel"],
  "setup-code-auth-timeout": [60_000, "timeout", false],
};
vi.mock("../../scripts/lib/managed-child-process.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mjs")>()),
  runManagedCommand: nativeMocks.command,
}));
vi.mock("../../scripts/lib/ios-release-e2e-build.js", () => ({
  prepareIOSReleaseNativeBuild: nativeMocks.build,
}));
vi.mock("../../scripts/lib/ios-release-gateway.js", () => ({
  prepareIOSReleaseGateway: nativeMocks.install,
}));
vi.mock("../helpers/openclaw-test-instance.js", () => ({
  createOpenClawTestInstance: nativeMocks.gateway,
}));
vi.mock("../../src/gateway/call.js", () => ({ callGateway: nativeMocks.rpc }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.values(nativeMocks).forEach((mock) => mock.mockReset());
});

function result(
  test: string = IOS_RELEASE_TESTS[0],
  overrides: Record<string, unknown> = {},
  bundleOverrides: Record<string, unknown> = {},
) {
  const testCase = {
    nodeType: "Test Case",
    nodeIdentifier: `${test.split("/").slice(1).join("/")}()`,
    result: "Passed",
    ...overrides,
  };
  const suite = { nodeType: "Test Suite", children: [testCase] };
  const bundle = {
    nodeType: "UI test bundle",
    name: test.split("/")[0],
    children: [suite],
    ...bundleOverrides,
  };
  return { testNodes: [{ nodeType: "Test Plan", children: [bundle] }] };
}

const childRuns = (nodeType: string, ...results: string[]) => ({
  children: results.map((runResult) => ({ nodeType, result: runResult })),
});

function expectFailedTrial(
  report: Awaited<ReturnType<typeof runTrials>>,
  error: string,
  diagnostics?: Partial<Trial["diagnostics"][number]>[],
  statuses: ("passed" | "failed")[] = [],
) {
  const tests = statuses.map((status, index) => ({ test: IOS_RELEASE_TESTS[index], status }));
  expectTrial(report, {
    status: "failed",
    errors: [error],
    tests,
    ...(diagnostics ? { diagnostics } : {}),
  });
}
function expectTrial(
  report: Awaited<ReturnType<typeof runTrials>>,
  fields: Record<string, unknown>,
) {
  expect(report.trials).toMatchObject([fields]);
}

const fixtureEvidence = (fields: Record<string, unknown>) => [matching(fields)];
const expectFixtures = (proof: Record<string, unknown>, fields: Record<string, unknown>) =>
  expect(proof.fixtures).toEqual(fixtureEvidence(fields));
const rpcEvidence = (responseReceived: boolean) =>
  matching({
    authenticated: true,
    dispatchEntered: true,
    responseReceived,
    timings: matching({
      authenticatedMs: expect.any(Number),
      dispatchEnteredMs: expect.any(Number),
      ...(responseReceived ? { responseReceivedMs: expect.any(Number) } : {}),
      elapsedMs: expect.any(Number),
    }),
  });

type Diagnostic = Trial["diagnostics"][number];
const diagnostic = (
  operation: Diagnostic["operation"],
  code: Diagnostic["code"],
  extra: Partial<Diagnostic> = {},
) => ({ operation, code, ...extra });
function preparationFailure(
  operation: Diagnostic["operation"],
  code: Diagnostic["code"],
  extra: Partial<Diagnostic> = {},
) {
  return {
    status: "failed",
    tests: [],
    errors: [
      code === "timeout"
        ? "preparation-timeout"
        : code === "cancelled"
          ? "cancelled"
          : "preparation-failed",
    ],
    diagnostics: [diagnostic(operation, code, extra)],
  };
}

describe("iOS release test identity", () => {
  it("accepts XCTest class/method identity under its exact UI bundle", () => {
    for (const test of IOS_RELEASE_TESTS) {
      requireExactTestResult(result(test, childRuns("Test Case Run", "Passed")), test);
    }
  });

  it.each([
    ["basename", result(undefined, { nodeIdentifier: IOS_RELEASE_TESTS[0].split("/").at(-1) })],
    ["skipped", result(undefined, { result: "Skipped" })],
    ["failed", result(undefined, { result: "Failed" })],
    ["failed child", result(undefined, childRuns("Test Case Run", "Failed"))],
    ["retry to green", result(undefined, childRuns("Repetition", "Passed", "Passed"))],
    ["multiple runs", result(undefined, childRuns("Test Case Run", "Passed", "Passed"))],
    ["wrong target", result(undefined, {}, { name: "OtherUITests" })],
    ["unit bundle", result(undefined, {}, { nodeType: "Unit test bundle" })],
    ["missing tests", { testNodes: [] }],
    [
      "extra tests",
      { testNodes: [...result().testNodes, ...result(IOS_RELEASE_TESTS[1]).testNodes] },
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => requireExactTestResult(value, IOS_RELEASE_TESTS[0])).toThrow();
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
  expect([child.error, child.signal, child.status], child.stderr).toEqual([undefined, null, 1]);
  const proof = JSON.parse(readFileSync(output, "utf8"));
  expect(proof).toMatchObject({
    targetSha,
    mode: "stock",
    status: "failed",
    trials: [],
    errors: ["gate-setup-failed"],
  });
  expect([proof.gatewayInstallMs, proof.nativeBuildMs]).toEqual([undefined, undefined]);
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
    expect(summarizeMeasurements(samples, 0, 5000)).toMatchObject({ complete: false, gapCount: 1 });
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
    fail?: "test" | "cleanup";
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
  it("runs live pairing and the independent reader test on one prepared simulator", async () => {
    const { deps, trace } = fixture();
    const report = await runTrials("stock", deps);
    expect(report.complete).toBe(true);
    expect(report.trials).toEqual(
      fixtureEvidence({
        status: "passed",
        tests: IOS_RELEASE_TESTS.map((test) => ({ test, status: "passed", ms: 10 })),
        preparationMs: 100,
        testMs: 20,
        totalMs: 125,
      }),
    );
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
  it("refuses comparison without a meter", async () => {
    const { deps } = fixture();
    await expect(runTrials("compare", deps)).rejects.toThrow("comparison-meter-required");
    expect(deps.create).not.toHaveBeenCalled();
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
  const release = parse(readFileSync(".github/workflows/ios-store-release.yml", "utf8"));
  const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const selectionArtifact = {
    id: 456,
    name: "ios-release-gateway-selection-123",
    expired: false,
    workflow_run: { id: 123, head_sha: "a".repeat(40) },
  };
  const pin = (run: Partial<typeof selectionArtifact.workflow_run>) => ({
    ...selectionArtifact,
    workflow_run: { ...selectionArtifact.workflow_run, ...run },
  });
  const reuseSelection = { create: "false", "artifact-id": "456" };
  const invalidPin = "expired or belongs to another source/run";
  async function findGatewaySelection(
    attempt: number,
    artifacts: (typeof selectionArtifact)[],
    outputs: Map<string, string>,
    apiFailure?: Error,
  ) {
    const { runInNewContext } = await import("node:vm");
    const step = workflow.jobs.qualify.steps.find(
      (candidate: { id?: string }) => candidate.id === "gateway-selection",
    );
    const listWorkflowRunArtifacts = vi.fn();
    const paginate = apiFailure
      ? vi.fn().mockRejectedValue(apiFailure)
      : vi.fn().mockResolvedValue(artifacts);
    const execution: unknown = runInNewContext(`(async () => { ${step.with.script} })()`, {
      github: { rest: { actions: { listWorkflowRunArtifacts } }, paginate },
      context: { repo: { owner: "openclaw", repo: "openclaw" }, runId: 123 },
      core: { setOutput: (name: string, value: string) => outputs.set(name, value) },
      process: {
        env: {
          GITHUB_RUN_ATTEMPT: String(attempt),
          TARGET_SHA: selectionArtifact.workflow_run.head_sha,
        },
      },
    });
    await execution;
    expect(paginate).toHaveBeenCalledWith(listWorkflowRunArtifacts, {
      owner: "openclaw",
      repo: "openclaw",
      run_id: 123,
      name: selectionArtifact.name,
      per_page: 100,
    });
  }
  it.each([
    ["new workflow run", 1, [], { create: "true", "artifact-id": "" }],
    ["existing first-attempt selection", 1, [selectionArtifact], reuseSelection],
    ["workflow rerun", 2, [selectionArtifact], reuseSelection],
  ])("preserves the Gateway selection for %s", async (_name, attempt, artifacts, expected) => {
    const outputs = new Map<string, string>();
    await findGatewaySelection(attempt, artifacts, outputs);
    expect(Object.fromEntries(outputs)).toEqual(expected);
  });
  it.each([
    ["missing rerun pin", [], "no saved stable Gateway selection"],
    ["expired pin", [{ ...selectionArtifact, expired: true }], invalidPin],
    [
      "duplicate pins",
      [selectionArtifact, selectionArtifact],
      "Multiple stable Gateway selections",
    ],
    ["different source", [pin({ head_sha: "b".repeat(40) })], invalidPin],
    ["different run", [pin({ id: 124 })], invalidPin],
  ])("rejects %s without authorizing a new selection", async (_name, artifacts, error) => {
    const outputs = new Map<string, string>();
    await expect(findGatewaySelection(2, artifacts, outputs)).rejects.toThrow(error);
    expect(outputs.size).toBe(0);
  });
  it("fails artifact lookup errors without treating the pin as missing", async () => {
    const outputs = new Map<string, string>();
    await expect(
      findGatewaySelection(1, [], outputs, new Error("artifact API unavailable")),
    ).rejects.toThrow("artifact API unavailable");
    expect(outputs.size).toBe(0);
  });
  it.each([
    ["manual current revision", {}, true],
    ["manual arbitrary target", { target: "b".repeat(40) }, false],
    ["invalid SHA", { target: "main" }, false],
    ["invalid mode", { mode: "unknown" }, false],
  ])("checks %s before checkout", (_name, options, admitted) => {
    const root = tempDirs.make("ios-e2e-workflow-authority-");
    const output = path.join(root, "outputs");
    const sha = "a".repeat(40);
    const target = "target" in options ? options.target : sha;
    const repository = "openclaw/openclaw";
    const ref = "refs/heads/main";
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
        GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ios-release-e2e.yml@${ref}`,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        TARGET_SHA: target,
        E2E_MODE: "mode" in options ? options.mode : "stock",
      },
    });
    expect(execution.status === 0).toBe(admitted);
    expect(readFileSync(path.join(root, "env"), "utf8")).toContain(
      `GATEWAY_SELECTION_DIR=${root}/ios-release-gateway-selection\n`,
    );
    const proof = JSON.parse(readFileSync(path.join(root, "ios-release-e2e-proof.json"), "utf8"));
    expect(proof).toMatchObject({ status: "failed", trials: [] });
  });
  it("isolates App Store qualification from the release checkout before accessing signing assets", () => {
    const releaseJob = release.jobs.release;
    const qualification = release.jobs[releaseJob.needs];
    expect(qualification).toMatchObject({
      uses: "./.github/workflows/ios-release-e2e.yml",
      permissions: { actions: "read", contents: "read" },
      with: { target_sha: "${{ github.sha }}", mode: "stock" },
    });
    expect(qualification.secrets).toBeUndefined();
    expect(qualification["continue-on-error"]).toBeUndefined();
    expect(releaseJob["continue-on-error"]).toBeUndefined();

    const steps = releaseJob.steps;
    expect(
      steps.some((step: { run?: string }) => step.run?.includes("scripts/ios-release-e2e.ts")),
    ).toBe(false);
    const signingStep = requiredWorkflowStep(steps, "Create apps-signing read token");
    const uploadStep = requiredWorkflowStep(steps, "Prepare and upload iOS release");
    const signing = steps.indexOf(signingStep);
    const upload = steps.indexOf(uploadStep);
    expect(signing).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(signing);
    for (const step of [steps[signing], steps[upload]]) {
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    }
    const recovery = requiredWorkflowStep(steps, "Retain release plan and notes");
    for (const outcome of ["skipped", "success", "failure", "cancelled"] as const) {
      expect(
        evaluateWorkflow(`\${{ ${recovery.if} }}`, {
          eventName: "workflow_dispatch",
          failed: true,
          steps: { [steps[upload].id]: { outputs: {}, outcome } },
        }),
      ).toBe(outcome !== "skipped");
    }
    expect(recovery.with["if-no-files-found"]).toBe("error");
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(ci.jobs["ios-release-e2e"].permissions).toEqual({ actions: "read", contents: "read" });
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
    const upload = requiredWorkflowStep(steps, "Upload sanitized proof only");
    expect(upload.if).toBe("always()");
    expect(upload.with.path.trim().split(/\r?\n/u)).toEqual([
      "${{ runner.temp }}/ios-release-e2e-proof.json",
      "${{ runner.temp }}/ios-resource-timeline.jsonl",
    ]);
    expect(upload.with.name).toBe(
      "ios-release-e2e-${{ inputs.mode }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
  });
  it.each([
    { flow: "qualification", enabled: true },
    { flow: "qualification", enabled: false },
    { flow: "screenshots", enabled: true },
    { flow: "screenshots", enabled: false },
  ])(
    "runs $flow with optional resource diagnostics=$enabled without masking failure",
    ({ flow, enabled }) => {
      const selected = flow === "qualification" ? workflow : release;
      expect(selected.on.workflow_dispatch.inputs.resource_diagnostics).toMatchObject({
        type: "boolean",
        default: true,
      });
      expect(workflow.on.workflow_call.inputs.resource_diagnostics).toMatchObject({
        type: "boolean",
        default: true,
      });
      const step = requiredWorkflowStep(
        flow === "qualification" ? workflow.jobs.qualify.steps : release.jobs.screenshots.steps,
        flow === "qualification"
          ? "Qualify native pairing and chat"
          : "Capture iPhone, iPad, and Watch screenshots",
      );
      const root = tempDirs.make("ios-workflow-resource-diagnostics-");
      const scripts = path.join(root, "scripts");
      const bin = path.join(root, "bin");
      mkdirSync(scripts);
      mkdirSync(bin);
      writeFileSync(
        path.join(scripts, "ios-resource-timeline.mjs"),
        readFileSync("scripts/ios-resource-timeline.mjs"),
      );
      writeFileSync(path.join(scripts, "tsx.mjs"), "export {};\n");
      const workload = path.join(scripts, "ios-release-e2e.ts");
      writeFileSync(
        workload,
        `
const fs = require("node:fs");
fs.writeFileSync(process.env.FIXTURE_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  diagnostics: process.env.OPENCLAW_IOS_RESOURCE_DIAGNOSTICS,
  snapshots: process.env.OPENCLAW_SNAPSHOT_DIAGNOSTICS,
  phasePath: process.env.OPENCLAW_IOS_RESOURCE_PHASE_PATH,
}));
process.exitCode = 23;
`,
      );
      const pnpm = path.join(bin, "pnpm");
      writeFileSync(pnpm, '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_WORKLOAD" "$@"\n');
      chmodSync(pnpm, 0o755);
      const stepEnv = Object.fromEntries(
        Object.entries(step.env as Record<string, string>).map(([key, value]) => [
          key,
          value.startsWith("${{")
            ? String(
                evaluateWorkflow(value, {
                  eventName: "workflow_dispatch",
                  inputs: { resource_diagnostics: enabled },
                  steps: { simslim: { outputs: { binary: "" } } },
                }),
              )
            : value,
        ]),
      );
      const record = path.join(root, "observed.json");
      const proof = path.join(root, "proof.json");
      const gateway = path.join(root, "gateway");
      const target = "a".repeat(40);
      const execution = spawnSync("/bin/bash", ["-c", step.run], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          ...stepEnv,
          PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
          FIXTURE_NODE: process.execPath,
          FIXTURE_WORKLOAD: workload,
          FIXTURE_RECORD: record,
          RUNNER_TEMP: root,
          PROOF_PATH: proof,
          GATEWAY_SELECTION_DIR: gateway,
          TARGET_SHA: target,
          E2E_MODE: "stock",
        },
      });
      expect(execution.status, execution.stderr).toBe(23);
      const observed = JSON.parse(readFileSync(record, "utf8"));
      expect(observed.diagnostics).toBe(enabled ? "1" : "0");
      expect(Boolean(observed.phasePath)).toBe(enabled);
      expect(readdirSync(root).includes("ios-resource-timeline.jsonl")).toBe(enabled);
      expect(observed.args).toEqual(
        flow === "qualification"
          ? [
              "--mode",
              "stock",
              "--target-sha",
              target,
              "--output",
              proof,
              "--gateway-selection",
              gateway,
            ]
          : ["ios:screenshots"],
      );
      if (flow === "screenshots") {
        expect(observed.snapshots).toBe("1");
      }
    },
  );
  it.each([
    ["full", "a".repeat(40), true],
    ["full", "b".repeat(40), false],
    ["main", "a".repeat(40), false],
  ])(
    "selects %s-tier target %s for required native qualification: %s",
    (tier, target, selected) => {
      const job = ci.jobs["ios-release-e2e"];
      expect(
        evaluateWorkflow(job.if, {
          eventName: "workflow_dispatch",
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
      const gate = requiredWorkflowStep(ci.jobs["ci-gate"].steps, "Verify selected CI lanes");
      expect(gate.env.JOB_RESULTS).toContain(
        `ios-release-e2e=\${{ needs.ios-release-e2e.result }}|${job.if}`,
      );
    },
  );
});

it.each([
  "dirty-tracked",
  "dirty-untracked",
  "source-late-dirty",
  "source-late-head-change",
  "different-xcode",
  "invalid-xcode-output",
  "newest-compatible-runtime",
  "unavailable-runtime",
  "unsupported-runtime-device",
  "unsupported-runtime-architecture",
  "non-ios-runtime",
  "cleanup-failure",
  "gateway-install-failure",
  "gateway-install-unjoined",
  "gateway-preflight-failure",
  "gateway-preflight-cleanup-failure",
  "build-unjoined",
  "build-exit",
  "boot-timeout",
  "gateway-start-failure",
  "setup-status-timeout",
  "setup-status-failure",
  "status-unjoined-gateway-exit",
  "gateway-exit-during-create",
  "gateway-exit-during-boot",
  "cancel-during-boot",
  "gateway-only",
  "native-build-only",
  "setup-code-timeout",
  "setup-code-rpc-timeout",
  "setup-code-fast-success",
  "setup-code-slow-success",
  "setup-code-join-success",
  "setup-code-join-observer-failure-success",
  "setup-code-join-failure",
  "setup-code-join-cancel",
  "setup-code-auth-timeout",
  "test-unjoined",
  "test-exit",
  "reader-failure",
  "fixture-exit",
  "gateway-exit",
  "missing-relaunch",
  "provider-duplicate",
  "provider-out-of-order",
  "provider-extra",
  "test-timeout-output",
  "reply-failure-evidence",
  "reply-failure-history-error",
  "reply-failure-source-only",
  "reply-failure-app-log-error",
])("native adapter owns admission, build, test and cleanup for %s", async (scenario) => {
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
  const setupPlan = setupPlans[scenario];
  let setupBegan: () => void = () => {};
  const setupStarted = new Promise<void>((resolve) => {
    setupBegan = resolve;
  });
  let diagnosticCalls = 0;
  const gatewayIdentity = {
    version: "2026.9.29",
    integrity: "sha512-YQ==",
    sourceSha: "2".repeat(40),
    lockSha256: "3".repeat(64),
    nodeVersion: process.version,
    npmVersion: "11.6.2",
  };
  let installedGatewayPath = "";
  nativeMocks.install.mockImplementation(async (options) => {
    lifecycle.push("gateway-install");
    if (scenario.startsWith("gateway-install-")) {
      throw Object.assign(
        new Error("private package installation failure"),
        scenario === "gateway-install-unjoined"
          ? { code: "ETIMEDOUT", processTreeState: "live" }
          : {},
      );
    }
    installedGatewayPath = path.join(options.installDir, "node_modules/openclaw");
    return { cwd: installedGatewayPath, entrypoint: ["openclaw.mjs"], identity: gatewayIdentity };
  });
  const preflightCleanup = vi.fn(async () => {
    lifecycle.push("gateway-preflight-cleanup");
    if (scenario === "gateway-preflight-cleanup-failure") {
      throw new Error("private preflight cleanup failure");
    }
  });
  const fixtureRpcCalls = () =>
    nativeMocks.rpc.mock.calls.filter(
      ([options]) =>
        options.configPath !== "/private/preflight/config.json" &&
        options.method !== "diagnostics.lanes",
    );
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
  const exitGateway = (code: number) => {
    gatewayChild.exitCode = code;
    gatewayChild.emit("exit", code, null);
  };
  let nativeCommandActive = false;
  let historyReadBeforeCommandExit = false;
  nativeMocks.rpc.mockImplementation(async (options) => {
    if (options.method === "diagnostics.lanes") {
      expect(lifecycle).not.toContain("gateway-cleanup");
      diagnosticCalls++;
      if (setupPlan && diagnosticCalls === 1) {
        lifecycle.push("setup-observer-start");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 3_000);
        });
        lifecycle.push("setup-observer-settled");
        if (scenario === "setup-code-join-failure") {
          throw new Error("private diagnostic failure");
        }
      }
      return {
        workerCount: 3,
        workerPoolCount: 1,
        lanes: [{ lane: "private-session", activeCount: 1, queuedCount: 2, maxConcurrent: 1 }],
        token: "private-credential",
      };
    }
    if (options.configPath === "/private/preflight/config.json") {
      expect(options).toMatchObject({ method: "device.pair.setupStatus" });
      lifecycle.push("gateway-preflight-rpc");
      expect(nativeMocks.build).not.toHaveBeenCalled();
      ensureGatewaySupportsRequiredFeatures({
        required: options.requiredMethods,
        supported: scenario === "gateway-preflight-failure" ? [] : ["chat.send", "chat.history"],
        kind: "method",
        attemptedMethod: options.method,
      });
      return {};
    }
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
    if (setupPlan && options.method === "device.pair.setupCode") {
      lifecycle.push("setup-code");
      return await new Promise((resolve, reject) => {
        const timers: ReturnType<typeof setTimeout>[] = [];
        const finish = (error?: Error) => {
          timers.forEach(clearTimeout);
          options.signal.removeEventListener("abort", cancel);
          lifecycle.push("setup-rpc-settled");
          if (error) {
            reject(error);
          } else {
            resolve({ setupCode: `synthetic-code-${instances.length}` });
          }
        };
        const cancel = () => finish(commandFailure("ABORT_ERR"));
        options.signal.addEventListener("abort", cancel, { once: true });
        if (setupPlan[2] !== false) {
          timers.push(setTimeout(() => options.onHelloOk?.(), 25));
          timers.push(setTimeout(() => options.assertDispatchCurrent?.(), 50));
        }
        timers.push(setTimeout(() => finish(rpcTimeout(options.timeoutMs)), options.timeoutMs));
        if (setupPlan[1] !== "timeout") {
          timers.push(
            setTimeout(() => {
              if (setupPlan[1] === "cancel") {
                abort.abort();
              } else {
                finish(setupPlan[1] === "failure" ? new Error("private setup failure") : undefined);
              }
            }, setupPlan[0]),
          );
        }
        setupBegan();
      });
    }
    options.onHelloOk?.();
    options.assertDispatchCurrent?.();
    if (options.method === "device.pair.setupStatus") {
      expect(simulatorReady).toBe(false);
      lifecycle.push("setup-status");
      if (scenario === "status-unjoined-gateway-exit") {
        exitGateway(17);
        throw commandFailure("ETIMEDOUT", "unknown");
      }
      if (scenario === "setup-status-timeout") {
        throw rpcTimeout(30_000, true);
      }
      if (scenario === "setup-status-failure") {
        throw new Error("private status preparation failure");
      }
      lifecycle.push("setup-status-ready");
      return {};
    }
    expect(options.method).toBe("device.pair.setupCode");
    expect(simulatorReady).toBe(scenario !== "gateway-only");
    lifecycle.push("setup-code");
    if (scenario === "setup-code-timeout") {
      throw new Error("private fixture command failed", {
        cause: Object.assign(new Error("private setup code and path"), { code: "ETIMEDOUT" }),
      });
    }
    return { setupCode: `synthetic-code-${instances.length}` };
  });
  nativeMocks.gateway.mockImplementation(async (options) => {
    expect(options).toMatchObject({ cwd: installedGatewayPath, entrypoint: ["openclaw.mjs"] });
    if (options.name === "ios-release-e2e-preflight") {
      lifecycle.push("gateway-preflight-create");
      return {
        url: "ws://127.0.0.1:19999",
        gatewayToken: "synthetic-preflight-token",
        configPath: "/private/preflight/config.json",
        startGateway: vi.fn(async () => {
          lifecycle.push("gateway-preflight-start");
        }),
        cleanup: preflightCleanup,
      };
    }
    expect(simulatorReady).toBe(false);
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
        exitGateway(0);
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
      expect(simulatorReady).toBe(false);
      if (scenario !== "gateway-only") {
        expect(lifecycle).toContain("native-build-complete");
      }
      lifecycle.push("mock-start");
      requestLog = options.env.MOCK_REQUEST_LOG;
      stdout.write("mock-openai listening on 20001\n");
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          joinedMocks++;
          lifecycle.push("mock-cleanup");
          reject(commandFailure("ABORT_ERR"));
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
          : scenario === "invalid-xcode-output"
            ? "unrecognized toolchain\n"
            : "Xcode 27.0\nBuild version 27A266a\n",
      );
    } else if (args.includes("--print-path")) {
      stdout.write(`${developerDir}\n`);
    } else if (args.includes("--show-sdk-build-version")) {
      stdout.write("27.0\n");
    } else if (args.includes("runtimes")) {
      const runtime = runtimeFixture("26.5", {
        available: scenario !== "unavailable-runtime",
        os: scenario === "non-ios-runtime" ? "watchOS" : "iOS",
        arch: scenario === "unsupported-runtime-architecture" ? "x86_64" : "arm64",
        device: scenario === "unsupported-runtime-device" ? "iPhone-16-Pro" : "iPhone-17-Pro",
      });
      stdout.write(
        JSON.stringify({
          runtimes:
            scenario === "newest-compatible-runtime"
              ? [
                  runtimeFixture("26.9"),
                  runtimeFixture("28.0", { available: false }),
                  runtimeFixture("29.0", { os: "watchOS" }),
                  runtimeFixture("30.0", { device: "none" }),
                  runtimeFixture("31.0", { arch: "x86_64" }),
                  runtime,
                  runtimeFixture("26.10"),
                ]
              : [runtime],
        }),
      );
    } else if (args.includes("create")) {
      expect(lifecycle).toContain("setup-status-ready");
      lifecycle.push("simulator-create");
      expect(args.at(-1)).toBe(
        scenario === "newest-compatible-runtime"
          ? "com.apple.CoreSimulator.SimRuntime.iOS-26-10"
          : "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      );
      if (scenario === "gateway-exit-during-create") {
        exitGateway(17);
        expect(options.signal.aborted).toBe(false);
      }
      stdout.write(`11111111-2222-3333-4444-${String(++created).padStart(12, "0")}`);
    } else if (args.includes("bootstatus")) {
      lifecycle.push("boot-wait");
      await Promise.resolve();
      if (scenario === "boot-timeout") {
        throw commandFailure("ETIMEDOUT");
      }
      if (scenario === "gateway-exit-during-boot" || scenario === "cancel-during-boot") {
        if (scenario === "gateway-exit-during-boot") {
          exitGateway(17);
        } else {
          abort.abort();
        }
        expect(options.signal.aborted).toBe(true);
        throw commandFailure("ABORT_ERR");
      }
      simulatorReady = true;
      lifecycle.push("boot-ready");
    } else if (args.includes("delete")) {
      lifecycle.push("simulator-delete");
    } else if (args.includes("build-for-testing")) {
      if (scenario !== "native-build-only") {
        expect(preflightCleanup).toHaveBeenCalledOnce();
        expect(lifecycle).toContain("gateway-preflight-rpc");
      }
      appContainer = path.join(
        path.dirname(args[args.indexOf("-derivedDataPath") + 1]!),
        "app-container",
      );
      if (scenario === "build-unjoined") {
        throw commandFailure("ETIMEDOUT", "live");
      }
      if (scenario === "build-exit") {
        stderr.write("BUILD FAILED: private setup code and private path\n");
        return 65;
      }
      lifecycle.push("native-build-complete");
    } else if (args.includes("test-without-building")) {
      const testArgument = args.find((arg) => arg.startsWith("-only-testing:"));
      if (!testArgument) {
        throw new Error("native test selection missing");
      }
      selectedTest = testArgument.slice("-only-testing:".length);
      const reader = selectedTest === IOS_RELEASE_TESTS[1];
      lifecycle.push(reader ? "reader-test" : "live-test");
      if (!reader) {
        stdout.write("IOS_RELEASE_CHECKPOINT paired\nIOS_RELEASE_CHECKPOINT private-credential\n");
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
                    content: prompt("OPENCLAW_E2E_RELAUNCH"),
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
                  { role: "user", content: prompt(marker) },
                  { role: "assistant", content: marker },
                  userInput(
                    "[Sun 2026-09-27 21:02 CDT] " +
                      "Conversation info: ⟦openclaw:ctx⟧\n```json\n" +
                      JSON.stringify({ sender: { id: "fixture-owner", name: marker } }) +
                      "\n```\n\n" +
                      (missing ? "No requested marker here." : prompt(marker)),
                  ),
                  userInput(
                    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" +
                      "OPENCLAW_E2E_FIRST\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
                  ),
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
        exitGateway(17);
        expect(options.signal.aborted).toBe(true);
        throw commandFailure("ABORT_ERR");
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
            : "IOS_RELEASE_CHAT_FAILURE relaunch reply draft=false keyboard=true reply=false writing=false jump=true foreground=true input=true transcript=true send=false";
        stdout.write(
          "Test Case '-[OpenClawUITests.OpenClawSnapshotUITests testLiveGatewayPairChatAndRelaunch]' started.\n" +
            `/private/checkout/OpenClawSnapshotUITests.swift:1913: error: private ${failureMessage}\n` +
            "Test Case '-[OpenClawUITests.OpenClawSnapshotUITests testLiveGatewayPairChatAndRelaunch]' failed (99 seconds).\n",
        );
        await Promise.resolve();
        nativeCommandActive = false;
        throw commandFailure("ETIMEDOUT");
      }
      if (scenario === "test-timeout-output") {
        stdout.write(
          "Test Case '-[OpenClawUITests.OpenClawSnapshotUITests testLiveGatewayPairChatAndRelaunch]' started.\n" +
            "/private/checkout/OpenClawSnapshotUITests.swift:1904: error: private assertion details\n" +
            "/private/checkout/OpenClawSnapshotUITests.swift:1904: error: repeated private details\n" +
            "/private/Other.swift:42: error: private details\n" +
            "Test Case '-[OpenClawUITests.OpenClawSnapshotUITests testLiveGatewayPairChatAndRelaunch]' failed (39.615 seconds).\n",
        );
        throw commandFailure("ETIMEDOUT");
      }
      if (scenario === "test-unjoined") {
        throw commandFailure("ETIMEDOUT", "unknown");
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
  let rejectedSlowProgress = false;
  const abort = new AbortController();
  const admission = createNativeDependencies({
    mode: "stock",
    targetSha: "1".repeat(40),
    signal: abort.signal,
    gatewayOnly: scenario === "gateway-only",
    buildOnly: scenario === "native-build-only",
    gatewaySelectionDir: path.join(temp, "selection"),
    proof,
    onProgress: async () => {
      progressSnapshots.push(JSON.stringify(proof));
      if (
        scenario === "setup-code-join-observer-failure-success" &&
        !rejectedSlowProgress &&
        (proof.fixtures as { setupDiagnostics?: { stage: string }[] }[] | undefined)?.some(
          (evidence) => evidence.setupDiagnostics?.some(({ stage }) => stage === "setup-code-slow"),
        )
      ) {
        rejectedSlowProgress = true;
        throw new Error("private diagnostic progress failure");
      }
    },
  });
  const dirtySource = scenario.startsWith("dirty-");
  const invalidRuntime = [
    "unavailable-runtime",
    "unsupported-runtime-device",
    "unsupported-runtime-architecture",
    "non-ios-runtime",
    "invalid-xcode-output",
  ].includes(scenario);
  const failedBuild = scenario.startsWith("build-");
  const failedInstall = scenario.startsWith("gateway-install-");
  const failedPreflight = scenario.startsWith("gateway-preflight-");
  const admissionFailures: [boolean, Partial<Diagnostic>][] = [
    [dirtySource, diagnostic("source-status", "dirty-source")],
    [scenario === "invalid-xcode-output", diagnostic("xcode-version", "failed")],
    [invalidRuntime, diagnostic("simulator-runtime", "not-found")],
    [
      scenario === "build-unjoined",
      diagnostic("native-build", "timeout", { errorCode: "ETIMEDOUT" }),
    ],
    [
      scenario === "build-exit",
      diagnostic("native-build", "exit", { exitCode: 65, context: ["build-failed"] }),
    ],
    [
      failedInstall,
      diagnostic("gateway-install", scenario === "gateway-install-unjoined" ? "timeout" : "failed"),
    ],
    [
      scenario === "gateway-preflight-cleanup-failure",
      diagnostic("cleanup", "cleanup-unconfirmed"),
    ],
    [failedPreflight, diagnostic("gateway-preflight", "failed")],
  ];
  const rejected = admissionFailures.find(([matches]) => matches)?.[1];
  if (rejected) {
    await expect(admission).rejects.toMatchObject({ diagnostic: rejected });
    const unjoined = scenario.endsWith("-unjoined");
    const preserved = unjoined || scenario === "gateway-preflight-cleanup-failure";
    expect(readdirSync(temp)).toHaveLength(preserved ? 1 : 0);
    if (dirtySource) {
      expect(nativeMocks.command.mock.calls).toHaveLength(2);
    }
    if (invalidRuntime) {
      expect(commandsWith("build-for-testing")).toHaveLength(0);
    }
    if (failedInstall || failedPreflight) {
      expect(nativeMocks.build).not.toHaveBeenCalled();
    }
    if (failedBuild || failedInstall) {
      expect(proof.resourcesPreserved).toBe(unjoined ? true : undefined);
    }
    if (failedInstall) {
      expect(nativeMocks.gateway).not.toHaveBeenCalled();
    }
    if (failedPreflight) {
      expect(preflightCleanup).toHaveBeenCalledOnce();
      expect(instances).toEqual([]);
      expect(created).toBe(0);
      expect(lifecycle).not.toContain("mock-start");
    }
    return;
  }
  const native = await admission;
  expect(proof).toMatchObject({
    xcode: scenario === "different-xcode" ? "26.6" : "27.0",
    xcodeBuild: scenario === "different-xcode" ? "17F113" : "27A266a",
    runtime: scenario === "newest-compatible-runtime" ? "26.10" : "26.5",
    runtimeIdentifier:
      scenario === "newest-compatible-runtime"
        ? "com.apple.CoreSimulator.SimRuntime.iOS-26-10"
        : "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  });
  try {
    if (scenario === "native-build-only") {
      expect(nativeMocks.build).toHaveBeenCalledOnce();
      expect(nativeMocks.install).not.toHaveBeenCalled();
      expect(nativeMocks.gateway).not.toHaveBeenCalled();
      expect(nativeMocks.rpc).not.toHaveBeenCalled();
      expect(created).toBe(0);
      expect(proof.gateway).toBeUndefined();
      expect(proof.gatewayInstallMs).toBeUndefined();
      return;
    }
    expect(nativeMocks.install).toHaveBeenCalledExactlyOnceWith({
      selectionDir: path.join(temp, "selection"),
      installDir: expect.stringMatching(/\/openclaw-ios-release-e2e-[^/]+\/gateway$/u),
      targetSha: "1".repeat(40),
      signal: abort.signal,
    });
    expect(proof.gateway).toEqual(gatewayIdentity);
    expect(proof.gatewayInstallMs).toEqual(expect.any(Number));
    if (scenario === "gateway-only") {
      const gatewayProbe = await native.dependencies.create("stock", 1);
      try {
        await gatewayProbe.prepare();
      } finally {
        await gatewayProbe.cleanup();
      }
      expect(lifecycle).toEqual([
        "gateway-install",
        "gateway-preflight-create",
        "gateway-preflight-start",
        "gateway-preflight-rpc",
        "gateway-preflight-cleanup",
        "mock-start",
        "gateway-create",
        "gateway-start",
        "setup-status",
        "setup-status-ready",
        "setup-code",
        "gateway-cleanup",
        "mock-cleanup",
      ]);
      expect(nativeMocks.build).not.toHaveBeenCalled();
      expect(created).toBe(0);
      expect(joinedMocks).toBe(1);
      expect(fixtureRpcCalls().map(([options]) => options.method)).toEqual([
        "device.pair.setupStatus",
        "device.pair.setupCode",
      ]);
      expectFixtures(proof, { cleanupConfirmed: true });
      return;
    }
    if (setupPlan) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    }
    let diagnosticsBeforeThreshold = 0;
    let diagnosticsAtThreshold = 0;
    let settledAtThirtySeconds = false;
    let joinedObserverBeforeContinuing = false;
    const reportPending = runTrials("stock", native.dependencies);
    if (setupPlan) {
      await setupStarted;
      if (scenario === "setup-code-fast-success") {
        await vi.advanceTimersByTimeAsync(1_000);
      } else {
        await vi.advanceTimersByTimeAsync(9_999);
        diagnosticsBeforeThreshold = diagnosticCalls;
        await vi.advanceTimersByTimeAsync(1);
        diagnosticsAtThreshold = diagnosticCalls;
        if (scenario.startsWith("setup-code-join-")) {
          await vi.advanceTimersByTimeAsync(1_000);
          joinedObserverBeforeContinuing =
            lifecycle.includes("setup-rpc-settled") &&
            !lifecycle.includes("setup-observer-settled") &&
            !lifecycle.includes("gateway-cleanup") &&
            !lifecycle.includes("live-test");
          await vi.advanceTimersByTimeAsync(2_000);
        } else {
          await vi.advanceTimersByTimeAsync(20_000);
          settledAtThirtySeconds = lifecycle.includes("setup-rpc-settled");
          await vi.advanceTimersByTimeAsync(
            scenario === "setup-code-slow-success" ? 5_000 : 30_000,
          );
        }
      }
    }
    const report = await reportPending;
    expect(instances).toHaveLength(1);
    expect(instances[0]?.cleanup).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain("private");
    if (setupPlan) {
      if (scenario !== "setup-code-fast-success") {
        expect(diagnosticsBeforeThreshold).toBe(0);
        expect(diagnosticsAtThreshold).toBe(1);
        if (scenario.startsWith("setup-code-join-")) {
          expect(joinedObserverBeforeContinuing).toBe(true);
        } else {
          expect(settledAtThirtySeconds).toBe(false);
        }
      }
      const [duration, outcome, auth] = setupPlan;
      const success = outcome === "success";
      const authenticated = auth !== false;
      expectFixtures(proof, {
        setupRpc: {
          authenticated,
          dispatchEntered: authenticated,
          responseReceived: success,
          timings: {
            ...(authenticated ? { authenticatedMs: 25, dispatchEnteredMs: 50 } : {}),
            ...(success ? { responseReceivedMs: duration } : {}),
            elapsedMs: duration,
          },
        },
      });
      const setupEvidence = (proof.fixtures as { setupDiagnostics: { stage: string }[] }[])[0];
      if (!setupEvidence) {
        throw new Error("Expected setup fixture evidence");
      }
      expect(
        setupEvidence.setupDiagnostics.filter(({ stage }) => stage === "setup-code-slow"),
      ).toHaveLength(scenario === "setup-code-fast-success" ? 0 : 1);
      const observations = diagnosticCalls;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(diagnosticCalls).toBe(observations);
      expect(vi.getTimerCount()).toBe(0);
      expect(
        fixtureRpcCalls().filter(([options]) => options.method === "device.pair.setupCode"),
      ).toHaveLength(1);
      if (scenario.startsWith("setup-code-join-")) {
        expectBefore(lifecycle, [["setup-observer-settled", "gateway-cleanup"]]);
      }
      if (scenario === "setup-code-join-observer-failure-success") {
        expect(rejectedSlowProgress).toBe(true);
      }
      if (!success) {
        expectFailedTrial(
          report,
          scenario === "setup-code-join-cancel"
            ? "cancelled"
            : scenario === "setup-code-join-failure"
              ? "preparation-failed"
              : "preparation-timeout",
        );
        expect(setupEvidence.setupDiagnostics).toEqual(
          containing([matching({ stage: "setup-code" })]),
        );
      }
    }
    expect(JSON.stringify(proof)).not.toMatch(/private|synthetic|OPENCLAW_E2E_|metadata/);
    expect(progressSnapshots.length).toBeGreaterThan(0);
    expect(progressSnapshots.join("\n")).not.toMatch(/private|synthetic|OPENCLAW_E2E_|metadata/);
    if (
      scenario === "setup-code-join-failure" ||
      scenario === "setup-code-join-cancel" ||
      scenario === "setup-code-auth-timeout"
    ) {
      return;
    }
    if (scenario.startsWith("reply-failure-")) {
      expect(report.complete).toBe(true);
      expectTrial(report, {
        status: "failed",
        errors: ["test-timeout"],
        diagnostics: [{ operation: "native-test", code: "timeout", errorCode: "ETIMEDOUT" }],
      });
      const context = report.trials[0]?.diagnostics[0]?.context;
      expect(context).toEqual(
        containing([
          ...(scenario === "reply-failure-source-only"
            ? []
            : [
                "chat-stage:relaunch",
                "chat-checkpoint:reply",
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
      expect(JSON.stringify(report)).not.toMatch(/private|OPENCLAW_E2E_|metadata/);
      return;
    }
    if (scenario === "test-timeout-output") {
      expect(report.complete).toBe(true);
      expectFailedTrial(
        report,
        "test-timeout",
        [
          diagnostic("native-test", "timeout", {
            errorCode: "ETIMEDOUT",
            context: containing(["xctest-started", "xctest-failed", "xctest-line:1904"]),
          }),
        ],
        ["failed"],
      );
      return;
    }
    const gatewayExit = preparationFailure("gateway-start", "exit", {
      exitCode: 17,
    });
    const preparationFailures: Record<string, ReturnType<typeof preparationFailure>> = {
      "boot-timeout": preparationFailure("simulator-ready", "timeout"),
      "gateway-start-failure": preparationFailure("gateway-start", "failed"),
      "setup-status-timeout": preparationFailure("setup-status", "timeout", {
        context: [
          "rpc-authenticated:true",
          "rpc-dispatch-entered:true",
          "rpc-request-dispatched:true",
        ],
      }),
      "setup-status-failure": preparationFailure("setup-status", "failed", {
        context: [],
      }),
      "status-unjoined-gateway-exit": {
        ...gatewayExit,
        errors: ["preparation-failed", "cleanup-failed"],
        diagnostics: [
          ...gatewayExit.diagnostics,
          { operation: "cleanup", code: "cleanup-unconfirmed" },
        ],
      },
      "gateway-exit-during-create": gatewayExit,
      "gateway-exit-during-boot": gatewayExit,
      "cancel-during-boot": preparationFailure("simulator-ready", "cancelled"),
    };
    const preparation = preparationFailures[scenario];
    if (preparation) {
      expect(report.trials).toMatchObject([preparation]);
      expect(lifecycle).not.toContain("live-test");
      expect(lifecycle).not.toContain("setup-code");
      expect(joinedMocks).toBe(1);
      if (scenario === "boot-timeout") {
        expect(lifecycle).toContain("setup-status-ready");
        expect(lifecycle.at(-1)).toBe("simulator-delete");
      } else if (scenario === "gateway-start-failure") {
        expect(created).toBe(0);
        expect(fixtureRpcCalls()).toHaveLength(0);
      }
      if (scenario.startsWith("setup-status-") || scenario === "status-unjoined-gateway-exit") {
        expect(fixtureRpcCalls()).toHaveLength(1);
        expect(created).toBe(0);
        if (scenario === "status-unjoined-gateway-exit") {
          expect(report.complete).toBe(false);
          expect(proof.resourcesPreserved).toBe(true);
        } else {
          expectFixtures(proof, { cleanupConfirmed: true, setupStatusRpc: rpcEvidence(false) });
        }
      }
      if (scenario.includes("during-")) {
        expect(lifecycle.at(-1)).toBe("simulator-delete");
        expect(gatewayChild.listenerCount("exit")).toBe(0);
      }
      return;
    }
    if (
      scenario.startsWith("missing-") ||
      scenario.startsWith("provider-") ||
      scenario === "fixture-exit" ||
      scenario === "gateway-exit"
    ) {
      const failure =
        scenario === "fixture-exit"
          ? diagnostic("fixture-server", "failed")
          : scenario === "gateway-exit"
            ? diagnostic("gateway-start", "exit", { exitCode: 17 })
            : diagnostic("provider-rpc", "failed");
      expectFailedTrial(report, "test-failed", [failure], ["failed"]);
      expect(lifecycle.filter((event) => event === "live-test")).toHaveLength(1);
      expect(lifecycle).not.toContain("reader-test");
      expect(joinedMocks).toBe(1);
      return;
    }
    if (scenario === "reader-failure") {
      expectFailedTrial(
        report,
        "test-failed",
        [diagnostic("native-test", "exit", { exitCode: 65 })],
        ["passed", "failed"],
      );
      expect(lifecycle.filter((event) => event.endsWith("-test"))).toEqual([
        "live-test",
        "reader-test",
      ]);
      expectBefore(lifecycle, [
        ["gateway-cleanup", "reader-test"],
        ["mock-cleanup", "reader-test"],
      ]);
      return;
    }
    if (scenario === "setup-code-timeout" || scenario === "setup-code-rpc-timeout") {
      expect(report.complete).toBe(true);
      expectFailedTrial(report, "preparation-timeout", [
        diagnostic("setup-code", "timeout", {
          ...(scenario === "setup-code-timeout" ? { errorCode: "ETIMEDOUT" } : {}),
          context:
            scenario === "setup-code-rpc-timeout"
              ? ["rpc-authenticated:true", "rpc-dispatch-entered:true"]
              : [],
        }),
      ]);
      expectFixtures(proof, {
        trial: 1,
        setupRpc: rpcEvidence(false),
        setupDiagnostics: containing([
          matching({ stage: "before-simulator" }),
          matching({ stage: "after-simulator" }),
          matching({ stage: "setup-code", gatewayExited: false }),
        ]),
      });
      expect(commandsWith("test-without-building")).toHaveLength(0);
      return;
    }
    if (scenario === "cleanup-failure" || scenario === "test-unjoined") {
      expect(report.complete).toBe(false);
      expect(report.trials).toHaveLength(1);
      expect(report.trials[0]?.errors).toContain("cleanup-failed");
      expect(proof.resourcesPreserved).toBe(true);
      if (scenario === "cleanup-failure") {
        expectFixtures(proof, {
          cleanupFailures: [matching({ source: "gateway", code: "failed" })],
        });
      }
      return;
    }
    if (scenario === "test-exit") {
      expect(report.trials.map((trial) => trial.status)).toEqual(["failed"]);
      expect(report.trials[0]?.diagnostics).toEqual([
        {
          operation: "native-test",
          code: "exit",
          exitCode: 65,
          context: containing(["test-failed", "xctest-line:1904"]),
        },
      ]);
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
    expectBefore(lifecycle, [
      ["mock-start", "boot-ready"],
      ["gateway-start", "boot-ready"],
      ["gateway-start", "setup-status"],
      ["setup-status-ready", "simulator-create"],
      ["boot-ready", "setup-code"],
      ["setup-code", "live-test"],
      ["gateway-cleanup", "reader-test"],
      ["mock-cleanup", "reader-test"],
    ]);
    expect(lifecycle.at(-1)).toBe("simulator-delete");
    expect(created).toBe(1);
    expect(joinedMocks).toBe(1);
    for (const index of instances.keys()) {
      expect(fixtureRpcCalls()).toHaveLength(2);
      expect(fixtureRpcCalls()[0]?.[0]).toEqual(
        matching({
          method: "device.pair.setupStatus",
          params: {
            setupId: expect.stringMatching(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
          },
          timeoutMs: 30_000,
          sharedStateMode: "read-only",
          token: `synthetic-token-${index + 1}`,
          url: `ws://127.0.0.1:${20001 + index}`,
        }),
      );
      expect(fixtureRpcCalls()[1]?.[0]).toEqual({
        config: {},
        configPath: `/private/fixture-${index + 1}/config.json`,
        url: `ws://127.0.0.1:${20001 + index}`,
        token: `synthetic-token-${index + 1}`,
        ignoreEnvUrlOverride: true,
        deviceIdentity: null,
        sharedStateMode: "read-only",
        method: "device.pair.setupCode",
        params: { publicUrl: `ws://127.0.0.1:${20001 + index}`, includeQr: false },
        timeoutMs: 60_000,
        signal: expect.any(AbortSignal),
        onHelloOk: expect.any(Function),
        assertDispatchCurrent: expect.any(Function),
      });
    }
    expectFixtures(proof, {
      trial: 1,
      cleanupConfirmed: true,
      setupStatusRpc: rpcEvidence(true),
      setupRpc: rpcEvidence(true),
      providerMessages: [
        { stage: "first", received: true },
        { stage: "second", received: true },
        { stage: "relaunch", received: true },
      ],
    });
    expect(proof.fixtures).not.toEqual(containing([matching({ gatewayExited: true })]));
    expect(gatewayChild.listenerCount("exit")).toBe(0);
    expect(proof.phases).toEqual(
      containing([
        matching({
          operation: "native-test",
          trial: 1,
          status: "passed",
          checkpoint: "overview",
        }),
      ]),
    );
    const builds = commandsWith("build-for-testing");
    expect(builds).toHaveLength(1);
    const [nativeBuild] = builds;
    expect(nativeBuild.args).toEqual(
      containing([
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
    const tests = commandsWith("test-without-building");
    expect(tests.map(({ env }) => env.TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE)).toEqual([
      "synthetic-code-1",
      "",
    ]);
    for (const { args: testArgs } of tests) {
      expect(testArgs).toContain("platform=iOS Simulator,id=11111111-2222-3333-4444-000000000001");
      expect(
        testArgs.slice(testArgs.indexOf("-xctestrun"), testArgs.indexOf("-xctestrun") + 2),
      ).toEqual(["-xctestrun", xctestrunPath]);
      expect(testArgs.some((argument: string) => argument.startsWith("CODE_SIGN"))).toBe(false);
      const diagnosticsIndex = testArgs.indexOf("-collect-test-diagnostics");
      expect(testArgs.slice(diagnosticsIndex, diagnosticsIndex + 2)).toEqual([
        "-collect-test-diagnostics",
        "never",
      ]);
      for (const excluded of [
        "-project",
        "-derivedDataPath",
        "-test-iterations",
        "-retry-tests-on-failure",
        "-run-tests-until-failure",
      ]) {
        expect(testArgs).not.toContain(excluded);
      }
    }
    expect(commandsWith("xcresulttool").map(({ args }) => args.slice(0, 4))).toEqual([
      ["xcresulttool", "get", "test-results", "tests"],
      ["xcresulttool", "get", "test-results", "tests"],
    ]);
    expect(commandsWith("delete").map(({ args }) => args.at(-1))).toEqual([
      "11111111-2222-3333-4444-000000000001",
    ]);
    expect(nativeMocks.gateway.mock.calls[1]?.[0]).toMatchObject({
      config: {
        gateway: { controlUi: { enabled: false } },
        agents: { defaults: { model: { primary: "openai/ios-e2e" } } },
      },
      env: gatewayEnv,
    });
  } finally {
    if (
      scenario === "cleanup-failure" ||
      scenario === "test-unjoined" ||
      scenario === "status-unjoined-gateway-exit"
    ) {
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
