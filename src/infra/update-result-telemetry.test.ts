import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { buildUpdateResultPayload, type UpdateResultPayload } from "./update-result-payload.js";
import * as outcomeTelemetry from "./update-result-telemetry.js";
import { sendUpdateResultTelemetry } from "./update-result-telemetry.js";
import { deadDriverFixture, updateRunFixture } from "./update-run-fixture.test-support.js";
import type { InterruptedUpdateGatewayObservation } from "./update-run-interruption-health.js";
import { reconcileInterruptedUpdateRuns } from "./update-run-interruption.js";
import {
  createUpdateRun,
  finishInterruptedUpdateBeforeActivation,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { createUpdateRunAsync, finishUpdateRunAsync } from "./update-run-write.async.js";

const health = vi.hoisted(() => ({
  observe: vi.fn<() => Promise<InterruptedUpdateGatewayObservation>>(),
}));
// mock-isolation: The interrupted-completion owner's Gateway probe is external I/O.
vi.mock("./update-run-interruption-health.js", () => ({
  observeInterruptedUpdateGateway: health.observe,
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    health.observe.mockReset();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

type ClaimState = { eligible: string[]; attempted: string[]; lastAttemptAt?: number };

function fixture(config: unknown = {}) {
  const directory = tempDirs.make("update-result-");
  const configPath = path.join(directory, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  // An explicit environment keeps policy independent of the test runner's CI variable.
  const env: NodeJS.ProcessEnv = {
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  return {
    env,
    configPath,
    claims: () => readConfigMachineState<ClaimState>("telemetry.updateResults", { env }),
  };
}

function settledRun(): UpdateRunRecord {
  return {
    runId: "8c68d9fc-135a-4fc2-9407-61ce04bd63c8",
    createdAtMs: 1000,
    updatedAtMs: 31000,
    trigger: "cli",
    phase: "finished",
    status: "succeeded",
    reason: null,
    origin: {},
    target: { version: "2026.9.19", installationMethod: "npm-global", channel: "stable" },
    before: { version: "2026.9.4" },
    after: { version: "2026.9.19" },
    steps: [],
    verification: {
      runningVersion: "2026.9.19",
      serviceRunning: true,
      versionMatch: true,
      readyz: true,
      channelsReady: true,
      settled: true,
      pluginErrors: [],
      rollbackOutcome: { status: "not-needed", reason: "unused" },
    },
    repair: [],
    confirmedAtMs: 31000,
    finishedAtMs: 31000,
    downtimeMs: null,
  };
}

const payload = () => buildUpdateResultPayload(settledRun(), "linux", "x64")!;

/** A run whose updater died after verification, ready for the interrupted-completion owner. */
function interruptedCompletion(env: NodeJS.ProcessEnv) {
  const candidate = { version: "2026.9.19", buildId: "interrupted-candidate" };
  const { dead: driver } = deadDriverFixture();
  const run = updateRunFixture({ env }, { trigger: "cli", origin: { driver }, reportResult: true });
  run.step({
    step: "finalize:installed-candidate",
    status: "completed",
    detail: JSON.stringify(candidate),
  });
  run.step({ step: "restarting", status: "completed" });
  run.step({ step: "post-update verification", status: "completed" });
  run.phase("verifying");
  health.observe.mockResolvedValue({
    outcome: "settled",
    elapsedMs: 1,
    phase: "fixture-health",
    verification: {
      booted: true,
      serviceRunning: true,
      runningVersion: candidate.version,
      runningBuildId: candidate.buildId,
      versionMatch: true,
      readyz: true,
      settled: true,
      channelsReady: true,
      pluginErrors: [],
    },
  });
  return run;
}

/** Make every later bookkeeping write fail inside the update transaction. */
async function rejectBookkeepingWrites(env: NodeJS.ProcessEnv) {
  await closeOpenClawStateDatabaseAsync();
  const db = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
  try {
    db.exec(`CREATE TRIGGER reject_update_result_bookkeeping
      BEFORE UPDATE ON config_machine_state WHEN NEW.state_key = 'telemetry.updateResults'
      BEGIN SELECT RAISE(ABORT, 'synthetic bookkeeping failure'); END`);
  } finally {
    db.close();
  }
}

type ReceivedRequest = {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: string;
};

/** A real loopback receiver; only its responses are synthetic. */
async function withReceiver(
  respond: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (endpoint: string, requests: ReceivedRequest[]) => Promise<void>,
) {
  const requests: ReceivedRequest[] = [];
  const listener = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          requests.push({
            method: request.method,
            url: request.url,
            headers: request.headers,
            body,
          });
          void Promise.resolve(respond(request, response)).catch(() => response.destroy());
        });
      }),
  });
  try {
    await run(`http://127.0.0.1:${listener.claim.port}/api/latest-version`, requests);
  } finally {
    listener.listener.closeAllConnections();
    await listener.releaseListener();
    await listener.claim.release();
  }
}

function capable(_request: IncomingMessage, response: ServerResponse) {
  response.writeHead(_request.method === "HEAD" ? 204 : 200, {
    "OpenClaw-Update-Results": "2",
  });
  response.end();
}

describe("identifier-free update result projection", () => {
  it("projects exactly the closed 18-field receiver wire shape", () => {
    const projected = payload();
    expect(projected).toEqual({
      schema: 2,
      event: "update_result",
      outcome: "succeeded",
      fromVersion: "2026.9.4",
      targetVersion: "2026.9.19",
      resultingVersion: "2026.9.19",
      runningVersion: "2026.9.19",
      platform: "linux",
      arch: "x64",
      installMethod: "npm-global",
      channel: "stable",
      duration: "under-1m",
      postCheck: "passed",
      failedStage: "none",
      errorCategory: "none",
      errorCode: "none",
      rollback: "not-needed",
      recovery: "unknown",
    });
    expect(Object.keys(projected)).toHaveLength(18);
  });

  it("produces identical bytes when identities and diagnostics change", () => {
    const second = settledRun();
    const marker = "private-marker.example /home/private token raw stderr git@private:repo";
    second.runId = marker;
    second.trigger = "chat";
    second.origin = {
      driver: { host: marker, pid: 1234, startIdentity: "123" },
      sessionKey: marker,
      campaignId: marker,
      requester: { channel: marker, accountId: marker, senderId: marker },
      deliveryContext: { channel: marker, to: marker, accountId: marker, threadId: marker },
      doctorHint: marker,
      nextAction: marker,
    };
    second.reason = marker;
    second.before.sha = marker;
    second.before.buildId = marker;
    second.after.sha = marker;
    second.after.buildId = marker;
    second.target.sha = marker;
    second.target.tag = marker;
    second.target.installationMethod = "ocm";
    second.steps = [
      {
        step: marker,
        status: "completed",
        detail: marker,
        failureFacts: [{ check: marker, code: marker, message: marker, location: marker }],
      },
    ];
    second.verification.runningBuildId = marker;
    second.verification.doctorHint = marker;
    second.verification.pid = 4321;
    second.verification.port = 9999;
    second.verification.rollbackOutcome = { status: "not-needed", reason: marker };
    second.repair = [
      { attempt: 1, status: "succeeded", startedAtMs: 123, summary: marker, reason: marker },
    ];
    const projected = JSON.stringify(buildUpdateResultPayload(second, "linux", "x64"));
    expect(projected).not.toContain("private");
    expect(projected).toBe(JSON.stringify({ ...payload(), installMethod: "unknown" }));
  });

  it.each([
    "2026.8.0",
    "2026.8.33",
    "2026.8.123",
    "2026.8.999999",
    "2026.8.33-1",
    "2026.8.33-beta.1",
  ])("preserves release-train version %s in every version field", (version) => {
    const run = settledRun();
    run.before.version = version;
    run.target.version = version;
    run.after.version = version;
    run.verification.runningVersion = version;
    expect(buildUpdateResultPayload(run)).toMatchObject({
      fromVersion: version,
      targetVersion: version,
      resultingVersion: version,
      runningVersion: version,
    });
  });

  it.each([
    "2026.8.1000000",
    "2026.8.033",
    "2026.13.1",
    "feature/private",
    "2026.9.19+private",
    "2026.9.19-private",
    "2026.9.19-beta.01",
    "host.example",
    "deadbeef",
    "v2026.9.19",
    "2026.9.19\n",
  ])("reports private or malformed version %s as unknown everywhere", (version) => {
    const run = settledRun();
    run.before.version = version;
    run.target.version = version;
    run.after.version = version;
    run.verification.runningVersion = version;
    expect(buildUpdateResultPayload(run)).toMatchObject({
      fromVersion: "unknown",
      targetVersion: "unknown",
      resultingVersion: "unknown",
      runningVersion: "unknown",
    });
  });

  it("keeps installed, running, and target versions distinct and classifies terminal failure", () => {
    const run = settledRun();
    run.status = "rolled-back";
    run.after.version = "2026.9.4";
    run.verification.runningVersion = "2026.9.3";
    run.verification.readyz = false;
    run.steps = [
      {
        step: "validating",
        status: "failed",
        failureFacts: [{ check: "private", code: "EACCES", message: "private" }],
      },
    ];
    expect(buildUpdateResultPayload(run)).toMatchObject({
      outcome: "rolled-back",
      targetVersion: "2026.9.19",
      resultingVersion: "2026.9.4",
      runningVersion: "2026.9.3",
      postCheck: "failed",
      failedStage: "validating",
      errorCode: "EACCES",
      errorCategory: "permission",
    });
    run.verification = {};
    expect(buildUpdateResultPayload(run)).toMatchObject({
      runningVersion: "unknown",
      postCheck: "unknown",
    });
    run.status = "skipped";
    expect(buildUpdateResultPayload(run)).toBeUndefined();
    run.status = "running";
    expect(buildUpdateResultPayload(run)).toBeUndefined();
  });
});

describe("ledger admission and at-most-once claims", () => {
  it.each(["succeeded", "failed", "rolled-back"] as const)(
    "reports a %s run once, only after its terminal write commits",
    (status) => {
      const { env, claims } = fixture();
      const run = createUpdateRun({ trigger: "cli", reportResult: true }, { env });
      expect(claims()).toEqual({ eligible: [run.runId], attempted: [] });
      const reported: UpdateResultPayload[] = [];
      const report = (value: UpdateResultPayload) => {
        // A fresh reader sees the committed terminal row and the consumed claim.
        expect(getUpdateRun(run.runId, { env })?.status).toBe(status);
        expect(claims()).toMatchObject({ eligible: [], attempted: [run.runId] });
        reported.push(value);
      };
      finishUpdateRun(run.runId, { status }, { env }, report);
      finishUpdateRun(run.runId, { status: "succeeded" }, { env }, report);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({ schema: 2, event: "update_result", outcome: status });
    },
  );

  it("never backfills runs admitted while update requests were disabled or by an older updater", () => {
    const { env, claims } = fixture();
    const admitted = createUpdateRun({ trigger: "cli", reportResult: true }, { env });
    const disabled = createUpdateRun({ trigger: "cli", reportResult: false }, { env });
    const legacy = createUpdateRun({ trigger: "cli" }, { env });
    const report = vi.fn();
    finishUpdateRun(disabled.runId, { status: "failed" }, { env }, report);
    finishUpdateRun(legacy.runId, { status: "succeeded" }, { env }, report);
    expect(report).not.toHaveBeenCalled();
    expect(claims()).toEqual({ eligible: [admitted.runId], attempted: [] });
  });

  it("allows one attempt per hour and suppresses attempts after a clock rollback", () => {
    const { env, claims } = fixture();
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const runs = Array.from({ length: 4 }, () =>
      createUpdateRun({ trigger: "api", reportResult: true }, { env }),
    );
    const report = vi.fn();
    finishUpdateRun(runs[0]!.runId, { status: "succeeded" }, { env }, report);
    finishUpdateRun(runs[1]!.runId, { status: "failed" }, { env }, report);
    now.mockReturnValue(start - 1);
    finishUpdateRun(runs[2]!.runId, { status: "failed" }, { env }, report);
    now.mockReturnValue(start + 60 * 60 * 1000);
    finishUpdateRun(runs[3]!.runId, { status: "failed" }, { env }, report);
    expect(report.mock.calls.map(([value]) => value.outcome)).toEqual(["succeeded", "failed"]);
    expect(claims()).toEqual({
      eligible: [],
      attempted: [runs[0]!.runId, runs[3]!.runId],
      lastAttemptAt: start + 60 * 60 * 1000,
    });
  });

  it("bounds eligibility and excludes previews and settlement receipts", () => {
    const { env, claims } = fixture();
    const runs = Array.from({ length: 20 }, () =>
      createUpdateRun({ trigger: "api", reportResult: true }, { env }),
    );
    createUpdateRun({ trigger: "cli", preview: true, reportResult: true }, { env });
    createUpdateRun(
      {
        trigger: "cli",
        reportResult: true,
        settlement: { reason: "fixture-settled", detail: "synthetic" },
      },
      { env },
    );
    expect(claims()?.eligible).toEqual(runs.slice(-16).map((run) => run.runId));
  });

  it.each(["superseded", "abandoned", "owner_required"])(
    "drops %s without reporting or using the hourly attempt",
    (reason) => {
      const { env, claims } = fixture();
      const run = createUpdateRun({ trigger: "cli", reportResult: true }, { env });
      const report = vi.fn();
      finishUpdateRun(run.runId, { status: "failed", reason }, { env }, report);
      expect(report).not.toHaveBeenCalled();
      expect(claims()).toEqual({ eligible: [], attempted: [] });
      const next = createUpdateRun({ trigger: "cli", reportResult: true }, { env });
      finishUpdateRun(next.runId, { status: "failed" }, { env }, report);
      expect(report).toHaveBeenCalledOnce();
    },
  );

  it("leaves the claim to a later reporting owner when storage settles without a reporter", () => {
    const { env } = fixture();
    const run = createUpdateRun({ trigger: "cli", reportResult: true }, { env });
    finishUpdateRun(run.runId, { status: "failed", reason: "cancelled" }, { env });
    const report = vi.fn();
    finishUpdateRun(run.runId, { status: "succeeded" }, { env }, report);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({ outcome: "failed" });
  });

  it("reports the settled verdict instead of an earlier repaired warning", () => {
    const { env } = fixture();
    const run = createUpdateRun({ trigger: "cli", reportResult: true }, { env });
    recordUpdateRunStep(
      run.runId,
      { step: "staging", status: "failed", failureFacts: [{ check: "staging", code: "ENOSPC" }] },
      { env },
    );
    recordUpdateRunVerification(
      run.runId,
      { serviceRunning: true, runningVersion: "2026.9.19" },
      { env },
    );
    const report = vi.fn();
    finishUpdateRun(run.runId, { status: "succeeded" }, { env }, report);
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      outcome: "succeeded",
      errorCode: "none",
      failedStage: "none",
      postCheck: "unknown",
      runningVersion: "2026.9.19",
    });
  });

  it("reports a settled pre-activation interruption once without a Gateway", () => {
    const { env } = fixture();
    const run = createUpdateRun({ trigger: "cli", reportResult: true }, { env });
    const report = vi.fn();
    finishInterruptedUpdateBeforeActivation(run, () => {}, { env }, report);
    finishUpdateRun(run.runId, { status: "failed" }, { env }, report);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      outcome: "failed",
      postCheck: "unknown",
      runningVersion: "unknown",
    });
  });
});

describe("worker-owned settlement", () => {
  it("admits by current host policy and dispatches the worker's claim after commit", async () => {
    const { env, configPath, claims } = fixture();
    const run = await createUpdateRunAsync({ trigger: "api" }, { env });
    expect(claims()?.eligible).toEqual([run.runId]);
    const dispatch = vi
      .spyOn(outcomeTelemetry, "sendUpdateResultTelemetry")
      .mockImplementation(async () => {
        // The host receives the claim only after the worker committed it.
        expect(claims()).toMatchObject({ eligible: [], attempted: [run.runId] });
      });
    const finished = await finishUpdateRunAsync(run.runId, { status: "failed" }, { env });
    expect(finished.status).toBe("failed");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ outcome: "failed" });
    expect(claims()).toMatchObject({ eligible: [], attempted: [run.runId] });

    fs.writeFileSync(configPath, JSON.stringify({ update: { checkOnStart: false } }));
    const disabled = await createUpdateRunAsync({ trigger: "api" }, { env });
    fs.writeFileSync(configPath, "{}");
    await finishUpdateRunAsync(disabled.runId, { status: "succeeded" }, { env });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(claims()?.eligible).toEqual([]);
  });

  it("reports an interrupted completion only after its owner verifies the serving candidate", async () => {
    const { env } = fixture();
    const run = interruptedCompletion(env);
    const dispatch = vi.spyOn(outcomeTelemetry, "sendUpdateResultTelemetry");
    await expect(reconcileInterruptedUpdateRuns({ env })).resolves.toMatchObject([
      { runId: run.id, status: "succeeded" },
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      outcome: "succeeded",
      resultingVersion: "2026.9.19",
      runningVersion: "2026.9.19",
      postCheck: "passed",
    });
  });
});

describe("failed bookkeeping never fails the update write", () => {
  it("commits sync admission and settlement without sending", async () => {
    const { env, claims } = fixture();
    const settled = createUpdateRun({ trigger: "cli", reportResult: true }, { env });
    await rejectBookkeepingWrites(env);
    const admitted = createUpdateRun({ trigger: "cli", reportResult: true }, { env });
    const report = vi.fn();
    expect(finishUpdateRun(settled.runId, { status: "failed" }, { env }, report).status).toBe(
      "failed",
    );
    expect(getUpdateRun(admitted.runId, { env })?.status).toBe("running");
    expect(getUpdateRun(settled.runId, { env })?.status).toBe("failed");
    expect(report).not.toHaveBeenCalled();
    expect(claims()).toEqual({ eligible: [settled.runId], attempted: [] });
  });

  // Worker creation verifies the whole schema and refuses this fixture's trigger; the
  // worker runs the same admission function the sync case above exercises.
  it("commits worker settlement without sending", async () => {
    const { env, claims } = fixture();
    const settled = await createUpdateRunAsync({ trigger: "api" }, { env });
    await rejectBookkeepingWrites(env);
    const send = vi.spyOn(outcomeTelemetry, "sendUpdateResultTelemetry");
    await expect(
      finishUpdateRunAsync(settled.runId, { status: "failed" }, { env }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(getUpdateRun(settled.runId, { env })?.status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect(claims()).toEqual({ eligible: [settled.runId], attempted: [] });
  });

  it("commits a verified interrupted completion without sending", async () => {
    const { env } = fixture();
    const run = interruptedCompletion(env);
    await rejectBookkeepingWrites(env);
    const send = vi.spyOn(outcomeTelemetry, "sendUpdateResultTelemetry");
    await expect(reconcileInterruptedUpdateRuns({ env })).resolves.toMatchObject([
      { runId: run.id, status: "succeeded" },
    ]);
    expect(getUpdateRun(run.id, { env })?.status).toBe("succeeded");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("bounded transport", () => {
  beforeEach(() => {
    // The sender stays offline under the test runner unless a case opts into real requests.
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("NODE_ENV", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("posts the exact body only after a capable HEAD, with fixed headers", async () => {
    const { env } = fixture();
    await withReceiver(capable, async (endpoint, requests) => {
      await sendUpdateResultTelemetry(payload(), {
        env: { ...env, OPENCLAW_TELEMETRY_ENDPOINT: endpoint },
      });
      expect(requests.map((request) => request.method)).toEqual(["HEAD", "POST"]);
      expect(requests[0]?.body).toBe("");
      expect(requests[1]?.body).toBe(JSON.stringify(payload()));
      for (const request of requests) {
        expect(request.headers["user-agent"]).toBe("openclaw-update-result/1");
        expect(request.headers).not.toHaveProperty("cookie");
        expect(request.headers).not.toHaveProperty("authorization");
        expect(request.headers).not.toHaveProperty("referer");
      }
      expect(requests[1]?.headers["content-type"]).toBe("application/json");
    });
  });

  it.each([
    { status: 405, capability: undefined },
    { status: 503, capability: undefined },
    { status: 204, capability: undefined },
    { status: 204, capability: "1" },
    { status: 200, capability: "2" },
    { status: 302, capability: "2" },
  ])("sends no outcome body to an unsupported receiver %j", async ({ status, capability }) => {
    const { env } = fixture();
    await withReceiver(
      (_request, response) => {
        response.writeHead(status, {
          ...(capability ? { "OpenClaw-Update-Results": capability } : {}),
          ...(status === 302 ? { location: "/redirected" } : {}),
        });
        response.end();
      },
      async (endpoint, requests) => {
        await sendUpdateResultTelemetry(payload(), {
          env: { ...env, OPENCLAW_TELEMETRY_ENDPOINT: endpoint },
        });
        expect(requests.map((request) => request.method)).toEqual(["HEAD"]);
      },
    );
  });

  it("rechecks update policy after the capability probe and sends nothing once revoked", async () => {
    const { env, configPath } = fixture();
    await withReceiver(
      (request, response) => {
        fs.writeFileSync(configPath, JSON.stringify({ update: { checkOnStart: false } }));
        capable(request, response);
      },
      async (endpoint, requests) => {
        await sendUpdateResultTelemetry(payload(), {
          env: { ...env, OPENCLAW_TELEMETRY_ENDPOINT: endpoint },
        });
        expect(requests.map((request) => request.method)).toEqual(["HEAD"]);
      },
    );
  });

  it("abandons a probe that never answers at the deadline", async () => {
    const { env } = fixture();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(20));
    await withReceiver(
      () => {
        // Never respond.
      },
      async (endpoint, requests) => {
        await expect(
          sendUpdateResultTelemetry(payload(), {
            env: { ...env, OPENCLAW_TELEMETRY_ENDPOINT: endpoint },
          }),
        ).resolves.toBeUndefined();
        expect(requests.map((request) => request.method)).toEqual(["HEAD"]);
      },
    );
  });

  it("bounds a stalled POST by the deadline that started before the probe", async () => {
    const { env } = fixture();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    // Only the first deadline is short; a fresh per-request deadline would hold the POST.
    vi.spyOn(AbortSignal, "timeout")
      .mockImplementationOnce(() => timeout(100))
      .mockImplementation(() => timeout(10_000));
    await withReceiver(
      (request, response) => {
        if (request.method === "HEAD") {
          capable(request, response);
        }
      },
      async (endpoint, requests) => {
        const startedAt = performance.now();
        await sendUpdateResultTelemetry(payload(), {
          env: { ...env, OPENCLAW_TELEMETRY_ENDPOINT: endpoint },
        });
        expect(performance.now() - startedAt).toBeLessThan(5_000);
        expect(requests.map((request) => request.method)).toEqual(["HEAD", "POST"]);
      },
    );
  });

  it("refuses to follow a redirected POST", async () => {
    const { env } = fixture();
    await withReceiver(
      (request, response) => {
        if (request.method === "HEAD") {
          capable(request, response);
          return;
        }
        response.writeHead(307, { location: "/redirected" });
        response.end();
      },
      async (endpoint, requests) => {
        await sendUpdateResultTelemetry(payload(), {
          env: { ...env, OPENCLAW_TELEMETRY_ENDPOINT: endpoint },
        });
        expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          "HEAD /api/latest-version",
          "POST /api/latest-version",
        ]);
      },
    );
  });

  it.each([
    (endpoint: string) => endpoint.replace("http://", "http://user:secret@"),
    (endpoint: string) => endpoint.replace("http://", "ftp://"),
  ])("sends nothing to an endpoint with credentials or a non-HTTP scheme", async (rewrite) => {
    const { env } = fixture();
    const attempts = vi.spyOn(globalThis, "fetch");
    await withReceiver(capable, async (endpoint, requests) => {
      await sendUpdateResultTelemetry(payload(), {
        env: { ...env, OPENCLAW_TELEMETRY_ENDPOINT: rewrite(endpoint) },
      });
      expect(attempts).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
    });
  });

  it.each([{ OPENCLAW_NO_AUTO_UPDATE: "1" }, { CI: "true" }, { OPENCLAW_NIX_MODE: "1" }])(
    "sends nothing with %j, even to a custom endpoint",
    async (suppression) => {
      const { env } = fixture();
      await withReceiver(capable, async (endpoint, requests) => {
        await sendUpdateResultTelemetry(payload(), {
          env: { ...env, ...suppression, OPENCLAW_TELEMETRY_ENDPOINT: endpoint },
        });
        expect(requests).toEqual([]);
      });
    },
  );

  it.each([
    { config: { update: { checkOnStart: false } } },
    { config: { telemetry: { enabled: true }, update: { checkOnStart: false } } },
    { config: "invalid JSON {" },
  ])("sends nothing when update policy is disabled or unreadable: $config", async ({ config }) => {
    const { env, configPath } = fixture();
    fs.writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
    await withReceiver(capable, async (endpoint, requests) => {
      await sendUpdateResultTelemetry(payload(), {
        env: { ...env, OPENCLAW_TELEMETRY_ENDPOINT: endpoint },
      });
      expect(requests).toEqual([]);
    });
  });

  it.each([
    { config: { telemetry: { enabled: false } }, extra: {} },
    { config: {}, extra: { DO_NOT_TRACK: "1" } },
  ])(
    "sends by default independently of feature statistics: $config $extra",
    async ({ config, extra }) => {
      const { env, configPath } = fixture(config);
      await withReceiver(capable, async (endpoint, requests) => {
        await sendUpdateResultTelemetry(payload(), {
          env: { ...env, ...extra, OPENCLAW_TELEMETRY_ENDPOINT: endpoint },
        });
        expect(requests.map((request) => request.method)).toEqual(["HEAD", "POST"]);
        expect(JSON.parse(requests[1]?.body ?? "")).not.toHaveProperty("features");
      });
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual(config);
    },
  );

  it("never falls back to another endpoint when the configured one fails", async () => {
    const { env } = fixture();
    await withReceiver(
      (_request, response) => {
        response.destroy();
      },
      async (endpoint, requests) => {
        const attempts = vi.spyOn(globalThis, "fetch");
        await expect(
          sendUpdateResultTelemetry(payload(), {
            env: { ...env, OPENCLAW_TELEMETRY_ENDPOINT: endpoint },
          }),
        ).resolves.toBeUndefined();
        expect(attempts.mock.calls.map(([input]) => input)).toEqual([endpoint]);
        expect(requests.map((request) => request.method)).toEqual(["HEAD"]);
      },
    );
  });
});
