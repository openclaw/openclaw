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
    { type: "lease.released" },
  ];
  return values.map((value, index) =>
    Object.assign(value, overrides[index], { runID: runId, seq: index + 1 }),
  );
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

function baseAncestry(overrides: Record<string, unknown> = {}) {
  return {
    ahead_by: 4,
    base_commit: { sha: baseSha },
    behind_by: 0,
    merge_base_commit: { sha: baseSha },
    status: "ahead",
    ...overrides,
  };
}

function mainAncestry(candidateMainSha = mainSha, overrides: Record<string, unknown> = {}) {
  return {
    ahead_by: candidateMainSha === workflowSha ? 0 : 4,
    base_commit: { sha: workflowSha },
    behind_by: 0,
    merge_base_commit: { sha: workflowSha },
    status: candidateMainSha === workflowSha ? "identical" : "ahead",
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
      if (args[0] === "config") {
        expect(stream).toBeUndefined();
        expect(input).toBeUndefined();
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            aws: { instanceProfile: "" },
            coordinator: "https://crabbox.example",
          }),
        };
      }
      expect(stream).toBe(true);
      expect(input).toBe(transport().input);
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
      return {
        exitCode: 0,
        stdout: "",
        stderr: `${JSON.stringify({
          exitCode: 0,
          label: `openclaw-pr-gate:130481:${baseSha}:${headSha}`,
          leaseId,
          leaseStopped: true,
          provider: "aws",
          runId,
          runStatus: "succeeded",
        })}\n`,
      };
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
    ["at the two-hour limit", proofEndedAt + 2 * 60 * 60 * 1000, false],
    ["one millisecond past the limit", proofEndedAt + 2 * 60 * 60 * 1000 + 1, true],
  ])("%s proof freshness", (_label, now, rejected) => {
    const verify = () =>
      validateBrokerProof({
        bootstrap,
        context: context(),
        events: brokerEvents(),
        log: retainedLog(),
        now,
        principal: servicePrincipal(),
        run: brokerRun(),
      });
    if (rejected) {
      expect(verify).toThrow(/fresh completed proof/u);
    } else {
      expect(verify).not.toThrow();
    }
  });

  it("caps retained output while preserving the final timing line", () => {
    const timing = `${JSON.stringify({
      exitCode: 0,
      leaseId,
      leaseStopped: true,
      provider: "aws",
      runId,
      runStatus: "succeeded",
    })}\n`;
    const oversized = Buffer.from("x".repeat(256 * 1024));
    const retained = appendCrabboxOutputTail(
      appendCrabboxOutputTail(Buffer.alloc(0), oversized),
      timing,
    );
    expect(retained.length).toBeLessThan(oversized.length);
    expect(retained.toString().endsWith(timing)).toBe(true);
  });

  it.each([
    ["provider", { provider: "blacksmith-testbox" }, brokerEvents(), retainedLog()],
    ["truncation", { logTruncated: true }, brokerEvents(), retainedLog()],
    ["command", { command: ["pnpm", "test"] }, brokerEvents(), retainedLog()],
    ...["head", "bootstrap digest", "command digest", "launcher digest"].map(
      (label, index) =>
        [
          label,
          {
            command: command().map((arg, position) =>
              position === index + 1 ? "f".repeat(arg.length) : arg,
            ),
          },
          brokerEvents(),
          retainedLog(),
        ] as const,
    ),
    [
      "bootstrap",
      {},
      brokerEvents({ 2: { message: ".crabbox/scripts/attacker.sh" } }),
      retainedLog(),
    ],
    [
      "failed event",
      {},
      brokerEvents({ 4: { exitCode: 1, type: "command.failed" } }),
      retainedLog(),
    ],
    ["marker", {}, brokerEvents(), retainedLog().replace("test:ok", "missing")],
  ] as const)("rejects mismatched %s", (_label, runOverrides, events, log) => {
    expect(() =>
      validateBrokerProof({
        bootstrap,
        context: context(),
        events,
        log,
        now: Date.parse("2026-08-28T02:00:00Z"),
        principal: servicePrincipal(),
        run: brokerRun(runOverrides),
      }),
    ).toThrow();
  });

  it("accepts empty retained logs when command and events are complete", () => {
    expect(() =>
      validateBrokerProof({
        bootstrap,
        context: context(),
        events: brokerEvents(),
        log: "",
        now: Date.parse("2026-08-28T02:00:00Z"),
        principal: servicePrincipal(),
        run: brokerRun(),
      }),
    ).not.toThrow();
  });

  it("recomputes the transport from the complete plan, even without retained logs", () => {
    expect(() =>
      validateBrokerProof({
        bootstrap,
        context: { ...context(), plan: { ...gatePlan(), targets: [] } },
        events: brokerEvents(),
        log: "",
        now: Date.parse("2026-08-28T02:00:00Z"),
        principal: servicePrincipal(),
        run: brokerRun(),
      }),
    ).toThrow(/canonical exact-head gate/u);
  });
});

describe("protected main ancestry", () => {
  it.each([
    [workflowSha, mainAncestry(workflowSha)],
    [mainSha, mainAncestry(mainSha)],
  ])("accepts live-shape identical or forward main %s", (candidateMainSha, comparison) => {
    expect(comparison).not.toHaveProperty("head_commit");
    expect(
      validateForwardAncestry(
        comparison,
        { baseSha: workflowSha, headSha: candidateMainSha },
        "protected main",
      ),
    ).toEqual({ baseSha: workflowSha, headSha: candidateMainSha });
  });

  it.each([
    ["behind", { behind_by: 1, status: "behind" }],
    ["diverged", { status: "diverged" }],
    ["wrong base", { base_commit: { sha: baseSha } }],
    ["wrong merge base", { merge_base_commit: { sha: baseSha } }],
    ["malformed ahead count", { ahead_by: "4" }],
    ["malformed behind count", { behind_by: "0" }],
  ])("rejects %s protected main comparison", (_label, override) => {
    expect(() =>
      validateForwardAncestry(
        mainAncestry(mainSha, override),
        { baseSha: workflowSha, headSha: mainSha },
        "protected main",
      ),
    ).toThrow(/protected main/u);
  });
});

describe("Crabbox gate publisher boundary", () => {
  let outputRoot: string;
  let outputPath: string;
  beforeEach(() => {
    outputRoot = mkdtempSync(path.join(tmpdir(), "crabbox-publisher-test-"));
    outputPath = path.join(outputRoot, "output");
  });
  afterEach(() => rmSync(outputRoot, { force: true, recursive: true }));

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
      mainShas?: string[];
      membership?: Record<string, unknown>;
      principal?: Record<string, unknown>;
      pull?: Record<string, unknown>;
      run?: Record<string, unknown>;
    } = {},
  ) {
    const orderedCalls: string[] = [];
    let mainReads = 0;
    const github = {
      request: vi.fn(async (method: string, requestPath: string, body?: unknown) => {
        orderedCalls.push(`github:${method}:${requestPath}`);
        if (requestPath.endsWith("/pulls/130481")) {
          return pullRequest(overrides.pull);
        }
        if (requestPath.endsWith("/git/ref/heads/main")) {
          const sha = overrides.mainShas?.[mainReads] ?? (mainReads < 2 ? mainSha : laterMainSha);
          mainReads += 1;
          return {
            object: { sha },
            ref: "refs/heads/main",
          };
        }
        if (requestPath.endsWith(`/compare/${baseSha}...${workflowSha}`)) {
          return baseAncestry(overrides.ancestry);
        }
        if (requestPath.includes(`/compare/${workflowSha}...`)) {
          return mainAncestry(requestPath.slice(-40));
        }
        if (method === "POST" && requestPath.endsWith("/check-runs")) {
          expect(body).toMatchObject({
            conclusion: "success",
            head_sha: headSha,
            name: "openclaw/crabbox-gate",
            output: {
              summary: formatCrabboxGateCheckSummary({
                baseSha,
                headSha,
                leaseId,
                planDigest: crabboxGatePlanDigest(gatePlan()),
                runId,
                targetCount: 1,
                workflowSha,
              }),
            },
          });
          return {
            app: { id: 15368 },
            conclusion: "success",
            head_sha: headSha,
            id: 88,
            name: "openclaw/crabbox-gate",
          };
        }
        throw new Error(`unexpected GitHub call: ${method} ${requestPath}`);
      }),
    };
    const organization = {
      request: vi.fn(async (method: string, requestPath: string) => {
        orderedCalls.push(`organization:${method}:${requestPath}`);
        return overrides.membership ?? activeMembership();
      }),
    };
    const broker = {
      request: vi.fn(async (requestPath: string, options?: { text?: boolean }) => {
        orderedCalls.push(`broker:${requestPath}`);
        if (requestPath === "/v1/whoami") {
          return servicePrincipal(overrides.principal);
        }
        if (requestPath.endsWith("/events?limit=500")) {
          return { events: brokerEvents() };
        }
        if (requestPath.endsWith("/logs") && options?.text) {
          return retainedLog();
        }
        if (requestPath === `/v1/runs/${runId}`) {
          return { run: brokerRun(overrides.run) };
        }
        throw new Error(`unexpected broker call: ${requestPath}`);
      }),
    };
    return { broker, github, orderedCalls, organization, runCrabbox: crabboxRunner() };
  }

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
    const runCrabbox = vi.fn(async (input: Parameters<typeof values.runCrabbox>[0]) => {
      const result = await values.runCrabbox(input);
      if (input.args[0] === "run") {
        clockNow = Date.parse("2026-08-28T02:00:00Z");
      }
      return result;
    });
    const resolvePlan = vi.fn(() => gatePlan());
    await expect(
      runPublisher({
        ...values,
        phase: "proof",
        clock: () => clockNow,
        env: phaseEnv("proof", {
          AWS_PROFILE: "must-not-leak",
          GH_TOKEN: "job-token",
          GH_APP_TOKEN: "initial-token",
        }),
        event: event(),
        organization: initialOrganization,
        resolvePlan,
        runCrabbox,
      }),
    ).resolves.toMatchObject({ checkId: null, context: { runId, leaseId } });
    expect(initialOrganization.request).toHaveBeenCalledTimes(1);
    expect(readFileSync(outputPath, "utf8")).toBe(`run_id=${runId}\nlease_id=${leaseId}\n`);
    expect(values.github.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
    expect(values.runCrabbox).toHaveBeenCalledTimes(2);
    expect(values.broker.request).toHaveBeenCalledWith(`/v1/runs/${runId}`);

    values.broker.request.mockClear();
    values.runCrabbox.mockClear();
    await expect(
      runPublisher({
        ...values,
        phase: "publish",
        clock: () => clockNow,
        env: phaseEnv("publish"),
        event: event(),
        resolvePlan,
      }),
    ).resolves.toMatchObject({
      checkId: 88,
      context: { baseSha, headSha, runId, leaseId, workflowSha },
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
    const runCrabbox = vi.fn(async (input: Parameters<typeof values.runCrabbox>[0]) => {
      const result = await values.runCrabbox(input);
      return input.args[0] === "run" ? { ...result, exitCode } : result;
    });
    await expect(
      runPublisher({
        ...values,
        phase: "proof",
        clock: () => proofEndedAt,
        env: phaseEnv("proof"),
        event: event(),
        resolvePlan: () => gatePlan(),
        runCrabbox,
      }),
    ).rejects.toThrow(failure);
    expect(existsSync(outputPath)).toBe(false);
    expect(values.github.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
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
    // Supply the actual CLI event as a file; no remote or inherited credentials.
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("GH_APP_TOKEN is required");
  });

  it("propagates output-write failure after joined proof without publishing", async () => {
    const values = harness();
    await expect(
      runPublisher({
        ...values,
        phase: "proof",
        clock: () => proofEndedAt,
        env: phaseEnv("proof", { GITHUB_OUTPUT: outputRoot }),
        event: event(),
        resolvePlan: () => gatePlan(),
      }),
    ).rejects.toThrow(/EISDIR/u);
    expect(values.runCrabbox).toHaveBeenCalledTimes(2);
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
      runPublisher({
        ...values,
        phase,
        env: phaseEnv(phase, overrides),
        event: event(),
        resolvePlan: () => gatePlan(),
      }),
    ).rejects.toThrow();
    expect(values.orderedCalls).toEqual([]);
    expect(values.runCrabbox).not.toHaveBeenCalled();
  });

  it.each([
    ["changed head", { pull: { head: { repo: { full_name: repository }, sha: "f".repeat(40) } } }],
    [
      "changed base",
      { pull: { base: { ref: "main", repo: { full_name: repository }, sha: "f".repeat(40) } } },
    ],
    ["revoked administrator", { membership: { ...activeMembership(), role: "member" } }],
    ["changed broker principal", { principal: { owner: "other-owner" } }],
    ["mismatched lease", { run: { leaseID: "cbx_other" } }],
    ["expired completed proof", { run: { endedAt: "2026-08-28T01:00:00Z" } }],
  ])("revalidates %s in the publication phase", async (_label, overrides) => {
    const values = harness(overrides);
    await expect(
      runPublisher({
        ...values,
        phase: "publish",
        clock: () => Date.parse("2026-08-28T03:00:00.001Z"),
        env: phaseEnv("publish"),
        event: event(),
        resolvePlan: () => gatePlan(),
      }),
    ).rejects.toThrow();
    expect(values.runCrabbox).not.toHaveBeenCalled();
    expect(values.github.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });

  it("rechecks membership immediately before publication", async () => {
    const values = harness();
    values.organization.request.mockResolvedValueOnce(activeMembership()).mockResolvedValueOnce({
      ...activeMembership(),
      role: "member",
    });
    await expect(
      runPublisher({
        ...values,
        phase: "publish",
        clock: () => proofEndedAt,
        env: phaseEnv("publish"),
        event: event(),
        resolvePlan: () => gatePlan(),
      }),
    ).rejects.toThrow(/not an active/u);
    expect(values.github.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });

  it("recomputes the publication plan instead of trusting output metadata", async () => {
    const values = harness();
    await expect(
      runPublisher({
        ...values,
        phase: "publish",
        clock: () => proofEndedAt,
        env: phaseEnv("publish"),
        event: event(),
        resolvePlan: () => ({ ...gatePlan(), targets: [] }),
      }),
    ).rejects.toThrow(/canonical exact-head gate/u);
    expect(values.runCrabbox).not.toHaveBeenCalled();
    expect(values.github.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });

  it("rejects non-admin, closed, or non-ancestor input before provisioning", async () => {
    for (const overrides of [
      { membership: { ...activeMembership(), state: "pending" } },
      { pull: { state: "closed" } },
      { ancestry: { behind_by: 1, status: "diverged" } },
    ]) {
      const values = harness(overrides);
      await expect(
        runPublisher({
          phase: "proof",
          ...values,
          env: phaseEnv("proof"),
          event: event(),
          resolvePlan: () => gatePlan(),
        }),
      ).rejects.toThrow();
      expect(values.runCrabbox).not.toHaveBeenCalled();
    }
  });

  it("rejects protected main moving between comparison and final ref reread", async () => {
    const values = harness({
      mainShas: [mainSha, mainSha, laterMainSha, "f".repeat(40)],
    });
    await expect(
      runPublisher({
        phase: "publish",
        ...values,
        clock: () => Date.parse("2026-08-28T02:00:00Z"),
        env: phaseEnv("publish"),
        event: event(),
        resolvePlan: () => gatePlan(),
      }),
    ).rejects.toThrow(/protected main moved/u);
    expect(values.github.request).not.toHaveBeenCalledWith(
      "POST",
      "/repos/openclaw/openclaw/check-runs",
      expect.anything(),
    );
  });

  it("requires the exact bearer service principal and same-owner broker run", async () => {
    for (const overrides of [
      { principal: { auth: "session" } },
      { principal: { org: "other" } },
      { principal: { admin: true } },
      { run: { owner: "github:42" } },
      { run: { org: "other" } },
    ]) {
      const values = harness(overrides);
      await expect(
        runPublisher({
          phase: "publish",
          ...values,
          clock: () => Date.parse("2026-08-28T02:00:00Z"),
          env: phaseEnv("publish"),
          event: event(),
          resolvePlan: () => gatePlan(),
        }),
      ).rejects.toThrow(/service principal|ownership/u);
    }
  });
});

describe("Crabbox broker authentication", () => {
  it.each([
    ["with Access", "access-id", "access-secret"],
    ["without Access", "", ""],
  ])("sends bearer authentication %s", async (_label, accessClientId, accessClientSecret) => {
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
    const api = createJsonApi({
      accessClientId,
      accessClientSecret,
      baseUrl: "https://broker.example/",
      fetchImpl,
      token: "coordinator-token",
    });
    await expect(api.request("/v1/whoami")).resolves.toEqual({ owner: "service" });
  });

  it("rejects a Cloudflare Access half-pair", () => {
    expect(() =>
      createJsonApi({
        accessClientId: "id",
        baseUrl: "https://broker.example/",
        token: "coordinator-token",
      }),
    ).toThrow(/provided together/u);
  });
});

describe("Crabbox gate workflow", () => {
  it("refreshes membership only after proof and never falls back to its old token", () => {
    const {
      jobs: {
        publish: { steps },
      },
    } = parseYaml(
      readFileSync(".github/workflows/pr-crabbox-gate-publisher.yml", "utf8"),
    ) as PublisherWorkflow;
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
      uses: "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
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
  });

  it("pins the publisher-owned run to protected main", () => {
    const workflow = parseYaml(
      readFileSync(".github/workflows/pr-crabbox-gate-publisher.yml", "utf8"),
    ) as PublisherWorkflow;
    const job = workflow.jobs.publish;
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
    expect(installCommand).toContain("crabbox_0.46.0_linux_amd64.tar.gz");
    expect(installCommand).toContain(
      "6a9341e810307356361dbed4c4b84be28a036b5cc291af1566d2ccd376570d90",
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
});
