import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  appendCrabboxOutputTail,
  buildCrabboxGateCommand,
  createJsonApi,
  runPublisher,
  validateBrokerProof,
  validatePublisherRequest,
} from "../../scripts/pr-crabbox-gate-publisher.mjs";
import {
  crabboxGatePlanDigest,
  formatCrabboxGateCheckSummary,
  validateForwardAncestry,
} from "../../scripts/pr-lib/crabbox-gate-contract.mjs";
import { buildCrabboxGateTransport } from "../../scripts/pr-lib/crabbox-gate-transport.mts";

const repository = "openclaw/openclaw";
const workflowSha = "a".repeat(40);
const baseSha = "c".repeat(40);
const headSha = "b".repeat(40);
const mainSha = "d".repeat(40);
const laterMainSha = "e".repeat(40);
const bootstrap = readFileSync("scripts/crabbox-untrusted-bootstrap.sh", "utf8");
const bootstrapSha256 = createHash("sha256").update(bootstrap).digest("hex");
const runId = "run_abc123";
const leaseId = "cbx_def456";
const serviceOwner = "unknown";
const proofEndedAt = Date.parse("2026-08-28T01:30:00Z");
const recoveryHomes = new Set<string>();
const proofContext = { baseSha, headSha, runId, leaseId, workflowSha };
const handoff = `run_id=${runId}\nlease_id=${leaseId}\n`;
const emptyResult = { exitCode: 0, stdout: "", stderr: "" };

type PublisherWorkflow = {
  jobs: {
    publish: {
      environment: string;
      permissions: Record<string, string>;
      steps: Array<{
        id?: string;
        if?: string;
        uses?: string;
        "continue-on-error"?: boolean;
        env?: Record<string, string>;
        run?: string;
        with?: Record<string, unknown>;
      }>;
      "timeout-minutes": number;
    };
  };
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  permissions: Record<string, unknown>;
  "run-name": string;
};

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CRABBOX_BIN: "/opt/crabbox",
    CRABBOX_COORDINATOR: "https://crabbox.example",
    CRABBOX_COORDINATOR_TOKEN: "broker-token",
    GITHUB_ACTOR: "maintainer",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: "1234",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_SHA: workflowSha,
    GITHUB_TRIGGERING_ACTOR: "maintainer",
    GITHUB_WORKFLOW_REF:
      "openclaw/openclaw/.github/workflows/pr-crabbox-gate-publisher.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: workflowSha,
    PATH: "/usr/bin:/bin",
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    inputs: {
      base_sha: baseSha,
      head_sha: headSha,
      pr_number: "130481",
      ...overrides,
    },
  };
}

function gatePlan() {
  return {
    baseSha,
    changedPaths: [{ path: "scripts/pr", status: "M" as const }],
    headSha,
    targets: ["test/scripts/pr-merge.test.ts"],
    version: 1 as const,
  };
}

function context() {
  return {
    ...validatePublisherRequest(event(), env()),
    leaseId,
    plan: gatePlan(),
    runId,
  };
}

function transport() {
  return buildCrabboxGateTransport({
    bootstrap,
    command: buildCrabboxGateCommand(gatePlan(), bootstrapSha256),
    headSha,
  });
}

function command() {
  return ["--script-stdin", ...transport().args];
}

function retainedLog() {
  return [
    "OPENCLAW_CRABBOX_GATE_VERSION=1",
    "OPENCLAW_CRABBOX_GATE_MODE=remote_crabbox_aws",
    `OPENCLAW_CRABBOX_GATE_BASE=${baseSha}`,
    `OPENCLAW_CRABBOX_GATE_HEAD=${headSha}`,
    `OPENCLAW_CRABBOX_GATE_PLAN_SHA256=${crabboxGatePlanDigest(gatePlan())}`,
    "OPENCLAW_CRABBOX_GATE_TARGET_COUNT=1",
    `OPENCLAW_CRABBOX_BOOTSTRAP_SHA256=${bootstrapSha256}`,
    "OPENCLAW_CRABBOX_GATE_STAGE=build:ok",
    "OPENCLAW_CRABBOX_GATE_STAGE=check:ok",
    "OPENCLAW_CRABBOX_GATE_STAGE=test:ok",
    "OPENCLAW_CRABBOX_GATE_RESULT=success",
  ].join("\n");
}

function brokerRun(overrides: Record<string, unknown> = {}) {
  return {
    command: command(),
    endedAt: "2026-08-28T01:30:00Z",
    eventCount: 6,
    exitCode: 0,
    id: runId,
    label: `openclaw-pr-gate:130481:${baseSha}:${headSha}`,
    leaseID: leaseId,
    logTruncated: false,
    org: "openclaw",
    owner: serviceOwner,
    phase: "released",
    provider: "aws",
    startedAt: "2026-08-28T01:00:00Z",
    state: "succeeded",
    target: "linux",
    ...overrides,
  };
}

function brokerEvents(overrides: Record<number, Record<string, unknown>> = {}) {
  const values = [
    { type: "run.started" },
    { leaseID: leaseId, provider: "aws", target: "linux", type: "lease.created" },
    {
      message: transport().uploadPath,
      type: "script.uploaded",
    },
    { type: "command.started" },
    { exitCode: 0, type: "command.finished" },
    { phase: "released", type: "lease.released" },
  ];
  return values.map((value, index) =>
    Object.assign(value, overrides[index], { runID: runId, seq: index + 1 }),
  );
}

function brokerLease(overrides: Record<string, unknown> = {}) {
  return {
    id: leaseId,
    owner: serviceOwner,
    org: "openclaw",
    provider: "aws",
    state: "released",
    cleanupStatus: "complete",
    cleanupCompletedAt: "2026-08-28T01:31:00Z",
    host: "",
    ...overrides,
  };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    base: { ref: "main", repo: { full_name: repository }, sha: baseSha },
    draft: true,
    head: { repo: { full_name: repository }, sha: headSha },
    number: 130481,
    state: "open",
    ...overrides,
  };
}

function ancestry(from = workflowSha, to = mainSha, overrides: Record<string, unknown> = {}) {
  return {
    ahead_by: from === to ? 0 : 4,
    base_commit: { sha: from },
    behind_by: 0,
    merge_base_commit: { sha: from },
    status: from === to ? "identical" : "ahead",
    ...overrides,
  };
}

function activeMembership() {
  return { role: "admin", state: "active", user: { login: "maintainer" } };
}

function servicePrincipal(overrides: Record<string, unknown> = {}) {
  return {
    admin: false,
    auth: "bearer",
    org: "openclaw",
    owner: serviceOwner,
    ...overrides,
  };
}

function timingLine() {
  return `${JSON.stringify({
    exitCode: 0,
    label: `openclaw-pr-gate:130481:${baseSha}:${headSha}`,
    leaseId,
    leaseStopped: true,
    provider: "aws",
    runId,
    runStatus: "succeeded",
  })}\n`;
}

function verifyProof(
  overrides: {
    events?: ReturnType<typeof brokerEvents>;
    log?: string;
    now?: number;
    run?: ReturnType<typeof brokerRun>;
  } = {},
) {
  return validateBrokerProof({
    bootstrap,
    context: context(),
    events: brokerEvents(),
    log: retainedLog(),
    now: Date.parse("2026-08-28T02:00:00Z"),
    principal: servicePrincipal(),
    run: brokerRun(),
    ...overrides,
  });
}

function crabboxRunner() {
  return vi.fn(
    async ({
      args,
      env: childEnv,
      stream,
      input,
    }: {
      args: string[];
      env: NodeJS.ProcessEnv;
      stream?: boolean;
      input?: string;
    }) => {
      recoveryHomes.add(childEnv.HOME!);
      if (args[0] === "config") {
        expect({ stream, input }).toEqual({ stream: undefined, input: undefined });
        return {
          ...emptyResult,
          stdout: JSON.stringify({
            aws: { instanceProfile: "" },
            coordinator: "https://crabbox.example",
          }),
        };
      }
      if (args[0] === "stop") {
        expect(args).toEqual(["stop", "--provider", "aws", "--id", leaseId, "--wait"]);
        expect({ stream, input }).toEqual({ stream: undefined, input: undefined });
        return { ...emptyResult, stderr: `released lease=${leaseId} server=fixture\n` };
      }
      expect({ stream, input }).toEqual({ stream: true, input: transport().input });
      expect(args.slice(-4)).toEqual(transport().args);
      expect(args).toEqual(
        expect.arrayContaining([
          "--provider",
          "aws",
          "--network",
          "public",
          "--tailscale=false",
          "--no-hydrate",
          "--idle-timeout",
          "90m",
          "--ttl",
          "240m",
          "--stop-after",
          "always",
          "--script-stdin",
          headSha,
        ]),
      );
      expect(childEnv).toMatchObject({
        CI: "1",
        CRABBOX_COORDINATOR: "https://crabbox.example",
        CRABBOX_COORDINATOR_TOKEN: "broker-token",
        CRABBOX_ENV_ALLOW: "CI",
        NO_COLOR: "1",
      });
      for (const name of [
        "AWS_PROFILE",
        "GH_TOKEN",
        "GH_APP_TOKEN",
        "GITHUB_OUTPUT",
        "CRABBOX_PROOF_RUN_ID",
        "CRABBOX_PROOF_LEASE_ID",
      ]) {
        expect(childEnv).not.toHaveProperty(name);
      }
      return { ...emptyResult, stderr: timingLine() };
    },
  );
}

describe("Crabbox gate request and broker proof", () => {
  it("accepts only the exact protected-main inputs", () => {
    expect(validatePublisherRequest(event(), env())).toMatchObject({
      baseSha,
      headSha,
      prNumber: 130481,
      workflowSha,
    });
    expect(() => validatePublisherRequest(event({ extra: "no" }), env())).toThrow(
      /keys must be exactly/u,
    );
  });

  it.each([
    [env({ GITHUB_REPOSITORY: "attacker/fork" }), event()],
    [env({ GITHUB_REF: "refs/pull/130481/merge" }), event()],
    [env({ GITHUB_SHA: "d".repeat(40) }), event()],
    [env(), event({ base_sha: "not-a-sha" })],
    [env({ GITHUB_TRIGGERING_ACTOR: "other" }), event()],
  ])("rejects untrusted request metadata", (inputEnv, inputEvent) => {
    expect(() => validatePublisherRequest(inputEvent, inputEnv)).toThrow();
  });

  it.each([
    ["at the two-hour limit", proofEndedAt + 2 * 60 * 60 * 1000, retainedLog(), false],
    ["one millisecond past the limit", proofEndedAt + 2 * 60 * 60 * 1000 + 1, retainedLog(), true],
    ["empty retained log", Date.parse("2026-08-28T02:00:00Z"), "", false],
  ])("validates %s proof", (_label, now, log, rejected) => {
    const verify = () => verifyProof({ now, log });
    if (rejected) {
      expect(verify).toThrow(/fresh completed proof/u);
    } else {
      expect(verify).not.toThrow();
    }
  });

  it("caps retained output while preserving the final timing line", () => {
    const timing = timingLine();
    const oversized = Buffer.from("x".repeat(256 * 1024));
    const retained = appendCrabboxOutputTail(
      appendCrabboxOutputTail(Buffer.alloc(0), oversized),
      timing,
    );
    expect(retained.length).toBeLessThan(oversized.length);
    expect(retained.toString().endsWith(timing)).toBe(true);
  });

  it.each([
    ["provider", { run: brokerRun({ provider: "blacksmith-testbox" }) }],
    ["truncation", { run: brokerRun({ logTruncated: true }) }],
    ["command", { run: brokerRun({ command: ["pnpm", "test"] }) }],
    ...["head", "bootstrap digest", "command digest", "launcher digest"].map(
      (label, index) =>
        [
          label,
          {
            run: brokerRun({
              command: command().map((arg, position) =>
                position === index + 1 ? "f".repeat(arg.length) : arg,
              ),
            }),
          },
        ] as const,
    ),
    ["bootstrap", { events: brokerEvents({ 2: { message: ".crabbox/scripts/attacker.sh" } }) }],
    ["failed event", { events: brokerEvents({ 4: { exitCode: 1, type: "command.failed" } }) }],
    ["terminal lease", { events: brokerEvents({ 5: { leaseID: "cbx_other" } }) }],
    ["terminal phase", { events: brokerEvents({ 5: { phase: "running" } }) }],
    ["marker", { log: retainedLog().replace("test:ok", "missing") }],
  ] as const)("rejects mismatched %s", (_label, overrides) => {
    expect(() => verifyProof(overrides)).toThrow();
  });
});

it.each([
  ["identical", workflowSha, {}, true],
  ["forward", mainSha, {}, true],
  ["behind", mainSha, { behind_by: 1, status: "behind" }, false],
  ["diverged", mainSha, { status: "diverged" }, false],
  ["wrong base", mainSha, { base_commit: { sha: baseSha } }, false],
  ["wrong merge base", mainSha, { merge_base_commit: { sha: baseSha } }, false],
  ["malformed ahead count", mainSha, { ahead_by: "4" }, false],
  ["malformed behind count", mainSha, { behind_by: "0" }, false],
] as const)(
  "validates %s protected main comparison",
  (_label, candidateMainSha, override, valid) => {
    const comparison = ancestry(workflowSha, candidateMainSha, override);
    const validate = () =>
      validateForwardAncestry(
        comparison,
        { baseSha: workflowSha, headSha: candidateMainSha },
        "protected main",
      );
    if (valid) {
      expect(comparison).not.toHaveProperty("head_commit");
      expect(validate()).toEqual({ baseSha: workflowSha, headSha: candidateMainSha });
    } else {
      expect(validate).toThrow(/protected main/u);
    }
  },
);

describe("Crabbox gate publisher boundary", () => {
  let outputRoot: string;
  let outputPath: string;
  beforeEach(() => {
    outputRoot = mkdtempSync(path.join(tmpdir(), "crabbox-publisher-test-"));
    outputPath = path.join(outputRoot, "output");
  });
  afterEach(() => {
    rmSync(outputRoot, { force: true, recursive: true });
    for (const home of recoveryHomes) {
      rmSync(home, { force: true, recursive: true });
    }
    recoveryHomes.clear();
  });

  function phaseEnv(phase: "proof" | "publish", overrides: NodeJS.ProcessEnv = {}) {
    return env({
      ...(phase === "proof"
        ? { GITHUB_OUTPUT: outputPath }
        : { CRABBOX_PROOF_RUN_ID: runId, CRABBOX_PROOF_LEASE_ID: leaseId }),
      ...overrides,
    });
  }
  function harness(
    overrides: {
      ancestry?: Record<string, unknown>;
      events?: ReturnType<typeof brokerEvents>;
      lease?: Record<string, unknown>;
      mainShas?: string[];
      membership?: Record<string, unknown>;
      principal?: Record<string, unknown>;
      pull?: Record<string, unknown>;
      run?: Record<string, unknown>;
    } = {},
  ) {
    const orderedCalls: string[] = [];
    let mainReads = 0;
    const check = { conclusion: "success", head_sha: headSha, name: "openclaw/crabbox-gate" };
    function request<Args extends unknown[]>(service: string, respond: (...args: Args) => unknown) {
      return {
        request: vi.fn(async (...args: Args) => {
          orderedCalls.push(`${service}:${args.slice(0, service === "broker" ? 1 : 2).join(":")}`);
          return respond(...args);
        }),
      };
    }
    const github = request("github", (method: string, requestPath: string, body?: unknown) => {
      if (requestPath.endsWith("/pulls/130481")) {
        return pullRequest(overrides.pull);
      }
      if (requestPath.endsWith("/git/ref/heads/main")) {
        const sha = overrides.mainShas?.[mainReads] ?? (mainReads < 2 ? mainSha : laterMainSha);
        mainReads += 1;
        return { object: { sha }, ref: "refs/heads/main" };
      }
      if (requestPath.endsWith(`/compare/${baseSha}...${workflowSha}`)) {
        return ancestry(baseSha, workflowSha, overrides.ancestry);
      }
      if (requestPath.includes(`/compare/${workflowSha}...`)) {
        return ancestry(workflowSha, requestPath.slice(-40));
      }
      if (method === "POST" && requestPath.endsWith("/check-runs")) {
        expect(body).toMatchObject({
          ...check,
          output: {
            summary: formatCrabboxGateCheckSummary({
              ...proofContext,
              planDigest: crabboxGatePlanDigest(gatePlan()),
              targetCount: 1,
            }),
          },
        });
        return { ...check, app: { id: 15368 }, id: 88 };
      }
      throw new Error(`unexpected GitHub call: ${method} ${requestPath}`);
    });
    const organization = request(
      "organization",
      (_method: string, _path: string) => overrides.membership ?? activeMembership(),
    );
    const broker = request("broker", (requestPath: string, options?: { text?: boolean }) => {
      const replies: Record<string, unknown> = {
        "/v1/whoami": servicePrincipal(overrides.principal),
        [`/v1/runs/${runId}`]: { run: brokerRun(overrides.run) },
        [`/v1/leases/${leaseId}`]: { lease: brokerLease(overrides.lease) },
      };
      if (requestPath.endsWith("/events?limit=500")) {
        return { events: overrides.events ?? brokerEvents() };
      }
      if (requestPath.endsWith("/logs") && options?.text) {
        return retainedLog();
      }
      if (Object.hasOwn(replies, requestPath)) {
        return replies[requestPath];
      }
      throw new Error(`unexpected broker call: ${requestPath}`);
    });
    return { broker, github, orderedCalls, organization, runCrabbox: crabboxRunner() };
  }

  type RunnerInput = Parameters<ReturnType<typeof crabboxRunner>>[0];
  type RunnerResult = Awaited<ReturnType<ReturnType<typeof crabboxRunner>>>;
  function changeRunner(
    values: ReturnType<typeof harness>,
    change: (step: string, result: RunnerResult) => RunnerResult | Promise<RunnerResult>,
  ) {
    return vi.fn(async (input: RunnerInput) =>
      change(input.args[0]!, await values.runCrabbox(input)),
    );
  }
  function unpublished(values: ReturnType<typeof harness>, outputExists = false) {
    expect(existsSync(outputPath)).toBe(outputExists);
    expect(values.github.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
  }
  function handedOff(values: ReturnType<typeof harness>) {
    expect(readFileSync(outputPath, "utf8")).toBe(handoff);
    unpublished(values, true);
  }
  function runPhase(
    values: ReturnType<typeof harness>,
    phase: "proof" | "publish",
    overrides: {
      clock?: () => number;
      env?: NodeJS.ProcessEnv;
      organization?: { request: () => Promise<ReturnType<typeof activeMembership>> };
      resolvePlan?: () => ReturnType<typeof gatePlan>;
      runCrabbox?: ReturnType<typeof crabboxRunner>;
    } = {},
  ) {
    return runPublisher({
      ...values,
      phase,
      clock: () => proofEndedAt,
      env: phaseEnv(phase),
      event: event(),
      resolvePlan: () => gatePlan(),
      ...overrides,
    });
  }

  it.each(["released", "cleanup"])(
    "waits for confirmed cleanup before handing off %s workload proof",
    async (phase) => {
      const values = harness({
        run: { phase },
        events: brokerEvents({ 5: { phase } }),
      });
      const stopStarted = Promise.withResolvers<void>();
      const stopCompleted = Promise.withResolvers<void>();
      const runCrabbox = changeRunner(values, async (step, result) => {
        if (step === "run") {
          return {
            ...result,
            stderr: result.stderr.replace('"leaseStopped":true', '"leaseStopped":false'),
          };
        }
        if (step === "stop") {
          stopStarted.resolve();
          await stopCompleted.promise;
        }
        return result;
      });
      const proof = runPhase(values, "proof", { runCrabbox });
      await stopStarted.promise;
      const homes = runCrabbox.mock.calls.map(([input]) => input.env.HOME);
      expect(new Set(homes).size).toBe(1);
      expect(existsSync(homes[0]!)).toBe(true);
      expect(existsSync(outputPath)).toBe(false);
      expect(values.broker.request).not.toHaveBeenCalledWith(`/v1/leases/${leaseId}`);
      stopCompleted.resolve();
      await expect(proof).resolves.toMatchObject({ context: { runId, leaseId } });
      expect(existsSync(homes[0]!)).toBe(false);
      handedOff(values);
      await expect(runPhase(values, "publish")).resolves.toMatchObject({ checkId: 88 });
    },
  );

  it.each([
    ["failed stop", { exitCode: 5, stderr: "cleanup pending" }, {}],
    ["accepted cleanup", { exitCode: 0, stderr: `release accepted lease=${leaseId}` }, {}],
    ["wrong stop lease", { exitCode: 0, stderr: "released lease=cbx_other server=fixture" }, {}],
    ["pending broker cleanup", {}, { cleanupStatus: "pending", cleanupCompletedAt: undefined }],
    ["wrong broker lease", {}, { id: "cbx_other" }],
    ["malformed completion receipt", {}, { cleanupCompletedAt: 1 }],
    ["retained access", {}, { host: "private-host.example" }],
  ])("retains recovery ownership after %s", async (_label, stop, lease) => {
    const values = harness({ lease });
    const runCrabbox = changeRunner(values, (step, result) =>
      step === "stop" ? { ...result, ...stop } : result,
    );
    const proof = runPhase(values, "proof", { runCrabbox });
    await expect(proof).rejects.toThrow(/recovery home retained/u);
    await expect(proof).rejects.toThrow(`run=${runId} lease=${leaseId}`);
    await expect(proof).rejects.toThrow(`crabbox stop --provider aws --id ${leaseId} --wait`);
    expect(existsSync(runCrabbox.mock.calls[0]![0].env.HOME!)).toBe(true);
    unpublished(values);
  });

  it("uses fresh membership authority after a proof outlives the initial token", async () => {
    const values = harness();
    let clockNow = Date.parse("2026-08-28T00:00:00Z");
    const initialOrganization = {
      request: vi.fn(async () => {
        if (clockNow >= Date.parse("2026-08-28T01:00:00Z")) {
          throw new Error("installation token expired");
        }
        return activeMembership();
      }),
    };
    const runCrabbox = changeRunner(values, (step, result) => {
      if (step === "run") {
        clockNow = Date.parse("2026-08-28T02:00:00Z");
      }
      return result;
    });
    const resolvePlan = vi.fn(() => gatePlan());
    await expect(
      runPhase(values, "proof", {
        clock: () => clockNow,
        env: phaseEnv("proof", {
          AWS_PROFILE: "must-not-leak",
          GH_TOKEN: "job-token",
          GH_APP_TOKEN: "initial-token",
        }),
        organization: initialOrganization,
        resolvePlan,
        runCrabbox,
      }),
    ).resolves.toMatchObject({ checkId: null, context: { runId, leaseId } });
    expect(initialOrganization.request).toHaveBeenCalledTimes(1);
    handedOff(values);
    expect(values.runCrabbox).toHaveBeenCalledTimes(3);
    expect(values.broker.request).toHaveBeenCalledWith(`/v1/runs/${runId}`);

    values.broker.request.mockClear();
    values.runCrabbox.mockClear();
    await expect(
      runPhase(values, "publish", {
        clock: () => clockNow,
        resolvePlan,
      }),
    ).resolves.toMatchObject({
      checkId: 88,
      context: proofContext,
    });
    expect(resolvePlan).toHaveBeenCalledTimes(2);
    expect(values.runCrabbox).not.toHaveBeenCalled();
    expect(values.broker.request.mock.calls[0]).toEqual(["/v1/whoami"]);
    expect(values.organization.request).toHaveBeenCalledTimes(2);
    expect(values.orderedCalls.at(-1)).toBe("github:POST:/repos/openclaw/openclaw/check-runs");
  });

  it.each([
    ["failed native command", 255, {}, /command failed/u],
    ["malformed run ID", 0, { id: "run_bad\nextra=1" }, /identity/u],
    ["unfinished release", 0, { phase: "running" }, /lifecycle/u],
    ["failed proof", 0, { state: "failed", exitCode: 1 }, /result/u],
  ] as const)("does not hand off %s", async (_label, exitCode, run, failure) => {
    const values = harness({ run });
    const runCrabbox = changeRunner(values, (step, result) =>
      step === "run" ? { ...result, exitCode } : result,
    );
    await expect(runPhase(values, "proof", { runCrabbox })).rejects.toThrow(failure);
    unpublished(values);
  });

  it("refuses publication when both fresh token steps provide no token", () => {
    writeFileSync(outputPath, JSON.stringify(event()));
    const result = spawnSync(
      process.execPath,
      ["scripts/pr-crabbox-gate-publisher.mjs", "--publish"],
      {
        encoding: "utf8",
        env: phaseEnv("publish", {
          GITHUB_EVENT_PATH: outputPath,
          GH_TOKEN: "job-token",
          GH_APP_TOKEN: "",
        }),
        input: "",
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("GH_APP_TOKEN is required");
  });

  it("propagates output-write failure after joined proof without publishing", async () => {
    const values = harness();
    await expect(
      runPhase(values, "proof", {
        env: phaseEnv("proof", { GITHUB_OUTPUT: outputRoot }),
      }),
    ).rejects.toThrow(/EISDIR/u);
    expect(values.runCrabbox).toHaveBeenCalledTimes(3);
    expect(values.github.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });

  it.each([
    ["missing output destination", "proof", { GITHUB_OUTPUT: "" }],
    ["missing run", "publish", { CRABBOX_PROOF_RUN_ID: "" }],
    ["missing lease", "publish", { CRABBOX_PROOF_LEASE_ID: "" }],
    ["injected run", "publish", { CRABBOX_PROOF_RUN_ID: `${runId}\nextra=1` }],
    ["injected lease", "publish", { CRABBOX_PROOF_LEASE_ID: `${leaseId}\nextra=1` }],
  ] as const)("rejects %s before external work", async (_label, phase, overrides) => {
    const values = harness();
    await expect(
      runPhase(values, phase, {
        env: phaseEnv(phase, overrides),
      }),
    ).rejects.toThrow();
    expect(values.orderedCalls).toEqual([]);
    expect(values.runCrabbox).not.toHaveBeenCalled();
  });

  const atTwo = { clock: () => Date.parse("2026-08-28T02:00:00Z") };
  function rejection(
    label: string,
    overrides: Parameters<typeof harness>[0],
    error?: RegExp,
    options: Parameters<typeof runPhase>[2] = atTwo,
    phase: "proof" | "publish" = "publish",
  ) {
    return { label, overrides, error, options, phase };
  }
  it.each([
    ...(
      [
        [
          "changed head",
          { pull: { head: { repo: { full_name: repository }, sha: "f".repeat(40) } } },
        ],
        [
          "changed base",
          { pull: { base: { ref: "main", repo: { full_name: repository }, sha: "f".repeat(40) } } },
        ],
        ["revoked administrator", { membership: { ...activeMembership(), role: "member" } }],
        ["changed broker principal", { principal: { owner: "other-owner" } }],
        ["mismatched lease", { run: { leaseID: "cbx_other" } }],
        ["pending cleanup", { lease: { cleanupStatus: "pending", cleanupCompletedAt: undefined } }],
        ["mismatched cleanup lease", { lease: { id: "cbx_other" } }],
        ["expired completed proof", { run: { endedAt: "2026-08-28T01:00:00Z" } }],
      ] satisfies [string, Parameters<typeof harness>[0]][]
    ).map(([label, overrides]) =>
      rejection(label, overrides, undefined, {
        clock: () => Date.parse("2026-08-28T03:00:00.001Z"),
      }),
    ),
    ...[
      { principal: { auth: "session" } },
      { principal: { org: "other" } },
      { principal: { admin: true } },
      { run: { owner: "github:42" } },
      { run: { org: "other" } },
    ].map((overrides) =>
      rejection("service principal or run ownership", overrides, /service principal|ownership/u),
    ),
    rejection("untrusted output plan", {}, /canonical exact-head gate/u, {
      resolvePlan: () => ({ ...gatePlan(), targets: [] }),
    }),
    rejection(
      "main moving during final reread",
      { mainShas: [mainSha, mainSha, laterMainSha, "f".repeat(40)] },
      /protected main moved/u,
    ),
    ...[
      { membership: { ...activeMembership(), state: "pending" } },
      { pull: { state: "closed" } },
      { ancestry: { behind_by: 1, status: "diverged" } },
    ].map((overrides) => rejection("ineligible proof input", overrides, undefined, {}, "proof")),
  ])(
    "rejects $label before publication or provisioning",
    async ({ overrides, error, options, phase }) => {
      const values = harness(overrides);
      await expect(runPhase(values, phase, options)).rejects.toThrow(error);
      expect(values.runCrabbox).not.toHaveBeenCalled();
      expect(values.github.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
    },
  );

  it("rechecks membership immediately before publication", async () => {
    const values = harness();
    values.organization.request.mockResolvedValueOnce(activeMembership()).mockResolvedValueOnce({
      ...activeMembership(),
      role: "member",
    });
    await expect(runPhase(values, "publish")).rejects.toThrow(/not an active/u);
    expect(values.github.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });
});

it.each([
  ["with Access", "access-id", "access-secret"],
  ["without Access", "", ""],
  ["with an invalid Access half-pair", "id", undefined],
])("validates bearer authentication %s", async (_label, accessClientId, accessClientSecret) => {
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    expect(init?.headers).toEqual({
      Authorization: "Bearer coordinator-token",
      ...(accessClientId
        ? {
            "CF-Access-Client-Id": accessClientId,
            "CF-Access-Client-Secret": accessClientSecret,
          }
        : {}),
    });
    return new Response('{"owner":"service"}', { status: 200 });
  });
  const createApi = () =>
    createJsonApi({
      accessClientId,
      accessClientSecret,
      baseUrl: "https://broker.example/",
      fetchImpl,
      token: "coordinator-token",
    });
  if (accessClientSecret === undefined) {
    expect(createApi).toThrow(/provided together/u);
  } else {
    await expect(createApi().request("/v1/whoami")).resolves.toEqual({ owner: "service" });
  }
});

it("pins proof to protected main and publishes with fresh membership authority", () => {
  const workflow = parseYaml(
    readFileSync(".github/workflows/pr-crabbox-gate-publisher.yml", "utf8"),
  ) as PublisherWorkflow;
  const job = workflow.jobs.publish;
  const { steps } = job;
  const proofIndex = steps.findIndex((step) => step.id === "proof");
  const proof = steps[proofIndex];
  const fresh = steps[proofIndex + 1];
  const fallback = steps[proofIndex + 2];
  const publish = steps[proofIndex + 3];
  expect(proof).toMatchObject({ run: "node scripts/pr-crabbox-gate-publisher.mjs --proof" });
  expect(proof?.["continue-on-error"]).toBeUndefined();
  expect(fresh).toMatchObject({
    id: "publish-app-token",
    if: "success() && steps.proof.outcome == 'success'",
    uses: "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510",
    "continue-on-error": true,
    with: { "app-id": "2729701", "permission-members": "read" },
  });
  expect(fallback).toMatchObject({
    id: "publish-app-token-fallback",
    if: "success() && steps.proof.outcome == 'success' && steps.publish-app-token.outcome == 'failure'",
    uses: fresh?.uses,
    "continue-on-error": true,
    with: { "app-id": "2971289", "permission-members": "read" },
  });
  expect(publish).toMatchObject({
    if: "success() && steps.proof.outcome == 'success'",
    env: {
      CRABBOX_PROOF_RUN_ID: "${{ steps.proof.outputs.run_id }}",
      CRABBOX_PROOF_LEASE_ID: "${{ steps.proof.outputs.lease_id }}",
      GH_APP_TOKEN:
        "${{ steps.publish-app-token.outputs.token || steps.publish-app-token-fallback.outputs.token }}",
      GH_TOKEN: "${{ github.token }}",
    },
    run: "node scripts/pr-crabbox-gate-publisher.mjs --publish",
  });
  expect(publish?.["continue-on-error"]).toBeUndefined();
  expect(steps.at(-1)).toBe(publish);
  expect(workflow["run-name"]).toBe(
    "PR Crabbox gate #${{ inputs.pr_number }} / ${{ inputs.head_sha }}",
  );
  expect(Object.keys(workflow.on.workflow_dispatch.inputs).toSorted()).toEqual([
    "base_sha",
    "head_sha",
    "pr_number",
  ]);
  expect(workflow.permissions).toEqual({});
  expect(job.environment).toBe("qa-live-shared");
  expect(job["timeout-minutes"]).toBe(270);
  expect(job.permissions).toEqual({
    checks: "write",
    contents: "read",
    "pull-requests": "read",
  });
  expect(job.steps[0]).toMatchObject({
    with: {
      "fetch-depth": 0,
      "persist-credentials": false,
      ref: "${{ github.workflow_sha }}",
    },
  });
  const installCommand = job.steps[2]?.run;
  if (typeof installCommand !== "string") {
    throw new Error("Crabbox install command is missing");
  }
  expect(installCommand).toContain("crabbox_0.79.2_linux_amd64.tar.gz");
  expect(installCommand).toContain(
    "316e2d788c9f85d0a7e876a0a91eab5e0a9257b8c572ca2c1372dbe066395dae",
  );
  expect(job.steps.at(-1)).toMatchObject({
    env: {
      CRABBOX_COORDINATOR:
        "${{ secrets.CRABBOX_COORDINATOR || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR }}",
      CRABBOX_COORDINATOR_TOKEN:
        "${{ secrets.CRABBOX_COORDINATOR_TOKEN || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR_TOKEN }}",
    },
    run: "node scripts/pr-crabbox-gate-publisher.mjs --publish",
  });
});
