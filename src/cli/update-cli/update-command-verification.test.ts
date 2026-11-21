import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveGatewayStartupTiming } from "../../commands/gateway-startup-timing.js";
import * as gatewayService from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { gitReleaseSlot } from "../../infra/git-release-paths.js";
import * as stale from "../../infra/restart-stale-pids.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { readUpdateRunReportHealth } from "../../infra/update-run-report-health.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import { isUpdateRunVerificationConfirmed } from "../../infra/update-run-verification.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import * as processIdentity from "../../shared/pid-alive.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as restart from "../daemon-cli/restart-health.test-helpers.js";
import { expectNoCalls } from "./update-boundary.test-support.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import {
  GatewayRestartHealthError,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";
import { maybeRestartService } from "./update-command-service.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-ledger.js")>()),
  recordUpdateRunPhase: vi.fn(),
  recordUpdateRunStep: vi.fn(),
  recordUpdateRunVerification: vi.fn(),
}));
vi.mock("../../infra/update-run-report-health.js", () => ({
  readUpdateRunReportHealth: vi.fn(async () => ({ kind: "unavailable" })),
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));
vi.mock("../../infra/gateway-supervision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-supervision.js")>()),
  assertGatewayServiceMutationAllowed: vi.fn(),
}));
vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: vi.fn(async () => undefined),
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: vi.fn(async () => "accepted"),
}));

let server: Server;
let controller: AbortController;
let pendingVerification: Promise<unknown> | undefined;
let result: ReturnType<typeof resultFixture>;
let gatewayPort: number;
let serviceEnv: NodeJS.ProcessEnv;
let candidate: { version: string; buildId: string };
type RestartParams = Parameters<typeof maybeRestartService>[0];
const withRun = (runId: string, executorFence?: { assertCurrent: () => void }) => ({
  json: true,
  run: { runId, env: {}, executorFence },
});
const defaults = () => ({ result, gatewayPort, serviceEnv, opts: { json: true } });
const command = vi.mocked(runUpdatedInstallGatewayCommand);
const lease = restart.readGatewayOwnerLease;
const rpc = restart.callGateway;
const running = { status: "running", pid: 8000 } as const;
function pendingHealth(waitOutcome: "still-starting" | "stopped-free", port = 18789) {
  return {
    healthy: false,
    waitOutcome,
    runtime: waitOutcome === "still-starting" ? running : { status: "stopped" as const },
    portUsage: { port, status: "free" as const, listeners: [], hints: [] },
    staleGatewayPids: [],
  };
}
function healthResponse(version: string | undefined, buildId?: string, bootId = "candidate-boot") {
  return gatewayHealthResponse({ server: { version, buildId, bootId } });
}
function useService(runtime: Parameters<typeof restart.makeGatewayService>[0] = running) {
  const service = restart.makeGatewayService(runtime);
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
  return service;
}
function busyPort(commandLine?: string, readyAtMs = 0, pid: number = running.pid) {
  restart.inspectPortUsage.mockImplementation(async (port) =>
    restart.portUsage(restart.monotonicClock.nowMs < readyAtMs ? [] : [{ pid, commandLine }], {
      port,
    }),
  );
}
function gatewayFixture(
  identity: Parameters<typeof gatewayHealthResponse>[0] = {},
  options: { platform?: NodeJS.Platform; commandLine?: string; readyAtMs?: number } = {},
) {
  mockProcessPlatform(options.platform ?? "linux");
  const service = useService();
  busyPort(options.commandLine, options.readyAtMs);
  rpc.mockImplementation(gatewayHealthResponse(identity));
  return service;
}
function verifyGateway(params: Partial<Parameters<typeof verifyUpdatedGateway>[0]> = {}) {
  return (pendingVerification = verifyUpdatedGateway({
    ...defaults(),
    expectedVersion: candidate.version,
    expectedBuildId: candidate.buildId,
    signal: controller.signal,
    ...params,
  }));
}
function restartGateway(params: Partial<RestartParams> = {}) {
  return maybeRestartService({
    ...defaults(),
    shouldRestart: true,
    refreshServiceEnv: false,
    requireRunningServiceAfterRestart: true,
    timeoutMs: 1_000,
    ...params,
  });
}
async function listen(handler: RequestListener = (_req, res) => res.writeHead(200).end()) {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing loopback listener");
  }
  gatewayPort = address.port;
  return gatewayPort;
}

async function verifyHealth(
  health: NonNullable<Parameters<typeof gatewayHealthResponse>[0]>["health"],
  recovery = false,
  json = true,
  readiness?: { ready: false; coreReady?: boolean; failing: string[] },
) {
  const version = recovery ? "2026.9.8" : "2026.10.3";
  const service = useService(recovery ? { status: "stopped" } : running);
  if (!recovery) {
    service.isLoaded = vi.fn(async () => true);
  }
  busyPort();
  const after = { version, buildId: "candidate" };
  const serving = { ...after, bootId: "candidate-boot" };
  rpc.mockImplementation(gatewayHealthResponse({ server: serving, health }));
  Object.assign(result, recovery ? { status: "error" } : { after });
  await listen((req, res) =>
    res
      .writeHead(req.url === "/readyz" && readiness ? 503 : 200)
      .end(readiness ? JSON.stringify(readiness) : undefined),
  );
  return await verifyGateway({
    opts: { json },
    expectedVersion: version,
    expectedBuildId: "candidate",
    requireRunningService: !recovery,
    purpose: "recovery",
    waitForStartup: false,
  });
}
const reportFor = (input: ReturnType<typeof resultFixture>) =>
  renderUpdateRunReport(updateRunReportInputFromResult(input)).markdown;

beforeEach(() => {
  controller = new AbortController();
  pendingVerification = undefined;
  result = resultFixture(undefined);
  gatewayPort = 18789;
  serviceEnv = { HOME: "/synthetic-home" };
  candidate = { version: "2026.9.4", buildId: "candidate-build" };
  vi.clearAllMocks();
  vi.mocked(recordUpdateRunVerification).mockReset();
  restart.resetRestartHealthMocks();
});
afterEach(async () => {
  controller.abort();
  await pendingVerification?.catch(() => {});
  restart.restoreRestartHealthMocks();
  server?.closeAllConnections();
  if (server?.listening) {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

it.each([
  ["npm", "ready", "2026.9.8", "candidate"],
  ["pnpm", "ready", "2026.9.8", "candidate"],
  ["bun", "ready", "2026.9.8", "candidate"],
  ["npm", "starting", undefined, undefined],
  ["npm", "old-version", "2026.9.7", "candidate"],
  ["npm", "old-build", "2026.9.8", "previous-build"],
  ["npm", "missing-build", "2026.9.8", undefined],
  ["npm", "retained-identity", "2026.9.7", "retained-build"],
] as const)(
  "observes a package watcher restart without failing --no-restart (%s, %s)",
  async (mode, state, version, buildId) => {
    const verified = state === "ready" || state === "retained-identity";
    gatewayFixture({}, { commandLine: "openclaw-gateway" });
    rpc.mockImplementation(
      state === "starting"
        ? async () => {
            throw new Error("gateway timeout after 3000ms");
          }
        : healthResponse(version, buildId, "watcher-successor"),
    );
    result.mode = mode;
    result.after = { version: "2026.9.8", buildId: "candidate" };
    await listen();
    const outcome = await restartGateway({
      opts: { ...withRun("watcher-restart"), restart: false },
      shouldRestart: false,
      requireRunningServiceAfterRestart: undefined,
      observePackageReplacement: true,
      expectedGatewayIdentity:
        state === "retained-identity"
          ? { version: "2026.9.7", buildId: "retained-build" }
          : undefined,
    });
    expect(outcome).toBe("ok");
    expect(command).not.toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.failureFacts).toBeUndefined();
    expect(result.steps[0]?.termination).toBeUndefined();
    expect(result.steps[0]?.advisory?.message).toEqual(
      verified ? undefined : expect.stringContaining("--no-restart"),
    );
    const facts = vi.mocked(recordUpdateRunVerification).mock.calls.at(-1)?.[1];
    expect(facts?.versionMatch).toBe(state === "starting" ? undefined : verified);
    expect(facts && isUpdateRunVerificationConfirmed(facts)).toBe(verified);
    if (state === "old-build") {
      expect(facts?.runningBuildId).toBe("previous-build");
      expect(result.steps[0]?.advisory?.message).toContain("candidate");
      expect(result.steps[0]?.advisory?.message).toContain("previous-build");
    }
  },
);

it.each(["transient-timeout", "mixed"])(
  "records collection and channel probe warnings after core verification (%s)",
  async (kind) => {
    gatewayFixture({}, { commandLine: "openclaw-gateway" });
    const timeout = "health collection timed out after 7000ms";
    const failed = { ok: false, timedOut: true, error: timeout };
    let probes = 0;
    rpc.mockImplementation((opts) =>
      gatewayHealthResponse({
        server: { version: "2026.9.8", buildId: "candidate", bootId: "candidate-boot" },
        health: {
          channels: {
            telegram: {
              probe: kind === "transient-timeout" && probes++ > 0 ? { ok: true } : failed,
            },
            ...(kind === "mixed"
              ? { discord: { probe: { ok: false, error: "invalid credentials" } } }
              : {}),
          },
        },
      })(opts),
    );
    await listen();
    using clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const onVerified = vi.fn(() => clock.mockReturnValue(2_000));
    const verification = await verifyGateway({
      opts: withRun("collection-timeout"),
      expectedVersion: "2026.9.8",
      expectedBuildId: "candidate",
      requireRunningService: true,
      onVerified,
    });
    expect(verification.ok).toBe(true);
    expect(verification.summary).toContain("channel warnings need attention");
    expect(verification.pluginWarnings).toBeUndefined();
    expect(onVerified).toHaveBeenCalledOnce();
    expect(result.steps[0]).toMatchObject({ exitCode: 0, durationMs: 0 });
    const facts = vi.mocked(recordUpdateRunVerification).mock.calls.at(-1)?.[1];
    expect(facts).toMatchObject({
      serviceRunning: true,
      versionMatch: true,
      readyz: true,
      settled: true,
      channelsReady: false,
    });
    expect(facts && isUpdateRunVerificationConfirmed(facts)).toBe(true);
    const report = reportFor(result);
    expect(report).toContain("telegram: health collection timed out after 7000ms");
    expect(report).toContain("openclaw channels status --probe");
    expect(report).toContain("openclaw health --json");
    expect(result.steps[0]?.warnings?.join("\n")).toContain(`telegram: ${timeout}`);
  },
);

it("bounds foreground recovery observation with hung readiness", async () => {
  useService({ status: "unknown" });
  busyPort();
  rpc.mockImplementation(healthResponse("2026.9.5", undefined, "foreground-boot"));
  await listen((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200).end();
    }
  });
  result.status = "error";
  const startedAt = Date.now();
  const verification = verifyGateway({
    purpose: "recovery",
    expectedVersion: "2026.9.5",
    expectedBuildId: undefined,
    waitForStartup: false,
    timeoutMs: 30 * 60_000,
  });
  await expect(verification).resolves.toMatchObject({ ok: false, summary: "readyz-unhealthy" });
  expect(Date.now() - startedAt).toBeLessThan(5_000);
  expect(result.verification).toMatchObject({ readyz: false, settled: false });
  expect(result.steps[0]).toMatchObject({
    exitCode: 1,
    failureFacts: expect.arrayContaining([
      expect.objectContaining({ check: "readyz", code: "readyz-unhealthy" }),
    ]),
  });
  expect(result.steps[0]?.termination).toBeUndefined();
  expect(result.steps[0]?.advisory).toBeUndefined();
  expect(restart.sleep).not.toHaveBeenCalled();
  for (const [params] of rpc.mock.calls) {
    expect(params.timeoutMs).toBeLessThanOrEqual(3_000);
  }
});

it("records expired recovery readiness before it settles", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mockProcessPlatform("linux");
  const entered = createDeferred();
  const released = createDeferred();
  useService();
  const onVerified = vi.fn();
  const lateMutation = vi.fn();
  const settle = vi.fn();
  pendingVerification = verifyGateway({
    opts: withRun("stalled-readiness"),
    expectedBuildId: undefined,
    requireRunningService: true,
    timeoutMs: 1_000,
    onVerified,
    recoverHealth: async (health, _reinspect, assertCurrent) => {
      entered.resolve();
      await released.promise;
      assertCurrent();
      lateMutation();
      return { health, launchAgentRecovery: null };
    },
    health: pendingHealth("stopped-free"),
  }).then(settle, settle);
  try {
    await entered.promise;
    restart.monotonicClock.nowMs = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: false }));
    expect(result.steps).toContainEqual(
      expect.objectContaining({ name: "gateway verification", exitCode: 1 }),
    );
    expect(onVerified).not.toHaveBeenCalled();
    released.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expectNoCalls(onVerified, lateMutation);
  } finally {
    controller.abort();
    released.resolve();
    await pendingVerification;
    vi.useRealTimers();
  }
});

it.each([true, false])(
  "names the last health probe when readiness expires in a later read (observed=%s)",
  async (observed) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockProcessPlatform("linux");
    useService();
    // The retained updater speaks an older protocol than the restarted Gateway.
    rpc.mockRejectedValue(restart.gatewayProtocolMismatchError());
    const inspecting = createDeferred();
    let completedInspections = Number(observed);
    restart.inspectPortUsage.mockImplementation(async (port) => {
      if (completedInspections-- > 0) {
        return { port, status: "busy", listeners: [{ pid: 8000 }], hints: [] };
      }
      inspecting.resolve();
      return await new Promise<never>(() => {});
    });
    const verification = verifyGateway({
      opts: withRun("readiness-timeout"),
      expectedBuildId: undefined,
      requireRunningService: true,
      timeoutMs: 60_000,
    });
    try {
      await inspecting.promise;
      restart.monotonicClock.nowMs = 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(verification).resolves.toMatchObject({ ok: false });
    } finally {
      vi.useRealTimers();
    }
    const deadline = "Gateway restart observation timed out during health-wait:port-inspection.";
    // Before the first observation, the wait owner's placeholder carries no probe result.
    const message = observed
      ? `${deadline} Last health probe: protocol mismatch: Web app v5, Gateway v4, connection check min v3`
      : deadline;
    expect(result.steps[0]?.failureFacts).toContainEqual({
      check: "settled",
      code: "timeout",
      message,
    });
    expect(reportFor(result)).toContain(message);
  },
);

it("prefers a pending recovery observation over previously saved healthy facts", async () => {
  result.status = "error";
  await expect(
    verifyGateway({
      opts: withRun("pending-recovery"),
      purpose: "recovery",
      gatewayPort: 19101,
      expectedVersion: "2026.9.5",
      expectedBuildId: undefined,
      health: pendingHealth("still-starting", 19101),
    }),
  ).resolves.toMatchObject({ ok: false, stopReason: "still-starting" });
  const saved: UpdateRunRecord["verification"] = {
    versionMatch: true,
    readyz: true,
    settled: true,
    runningVersion: "2026.9.5",
    recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
  };
  const input = updateRunReportInputFromResult(result);
  const report = renderUpdateRunReport(input);
  expect(report.markdown).not.toContain("verified serving");
  expect(report.markdown).toContain("readiness is pending");
  const publicReport = await prepareUpdateFailureReport(
    {
      attemptId: "pending-recovery",
      result,
      recordedRun: { runId: "pending-recovery", steps: input.steps, verification: saved },
    },
    { env: {}, stateDir: "/fixture/state" },
  );
  expect(publicReport.body).not.toContain("verified serving");
  expect(publicReport.body).toContain("readiness is pending");
  expect(readUpdateRunReportHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ readyz: false, settled: false, port: 19101 }),
    expect.anything(),
  );
});

it.each(["runtime", "port", "command"] as const)(
  "keeps recovery observation factual with inspection cleanup: %s",
  async (fault) => {
    const service = gatewayFixture({
      server: { version: "2026.9.5", buildId: "candidate-build", bootId: "recovery-boot" },
    });
    await listen();
    const cleanup = new AggregateError(
      [new CommandProcessCleanupError()],
      "inspection cleanup uncertain",
    );
    const probe =
      fault === "port"
        ? restart.inspectPortUsage
        : vi.spyOn(service, fault === "runtime" ? "readRuntime" : "readCommand");
    probe.mockRejectedValue(cleanup);
    Object.assign(result, { status: "error", reason: "post-update-plugins" });
    const verification = verifyGateway({
      opts: withRun("observed-recovery"),
      purpose: "recovery",
      expectedVersion: "2026.9.5",
    });
    await expect(verification).rejects.toBe(cleanup);
    expect(result.verification).toBeUndefined();
    expect(result.steps).toEqual([]);
  },
);

it.each([
  { activation: "native restart", exhausted: true },
  { activation: "receipt", exhausted: false },
  { activation: "mismatched receipt", exhausted: false },
  { activation: "stopped receipt", exhausted: false },
  { activation: "service refresh", exhausted: false },
  { activation: "service refresh", exhausted: true },
  { activation: "child readiness timeout", exhausted: true },
])(
  "preserves a slow startup ($activation, exhausted=$exhausted)",
  async ({ activation, exhausted }) => {
    const refreshServiceEnv = activation === "service refresh";
    const childTimeout = activation === "child readiness timeout";
    if (childTimeout) {
      command.mockImplementationOnce(async () => {
        restart.monotonicClock.nowMs = 60_000;
        throw new GatewayRestartHealthError("Gateway restart timed out waiting for health checks.");
      });
    }
    gatewayFixture({ server: { ...candidate, bootId: "slow-boot" } }, { readyAtMs: 90_000 });
    await listen();
    if (activation.includes("receipt")) {
      command.mockImplementationOnce(async ({ onReadiness }) => {
        const { waitForGatewayHealthyRestart } = await import("../daemon-cli/restart-health.js");
        const health = await waitForGatewayHealthyRestart({
          service: gatewayService.resolveGatewayService(),
          port: gatewayPort,
          env: serviceEnv,
          timeoutMs: 120_000,
        });
        if (activation === "mismatched receipt") {
          health.gatewayBuildId = "previous-build";
        } else if (activation === "stopped receipt") {
          health.runtime = { status: "stopped" };
        }
        onReadiness?.(health);
        return "accepted";
      });
    }
    result.after = { ...candidate };
    const outcome = await restartGateway({
      opts: withRun("restart-readiness"),
      refreshServiceEnv,
      timeoutMs: exhausted ? 60_000 : 120_000,
    });
    const pending = exhausted && !childTimeout;
    expect(outcome).toBe(pending ? "readiness-pending" : "ok");
    const facts = vi.mocked(recordUpdateRunVerification).mock.lastCall?.[1];
    expect(facts?.versionMatch).toBe(pending ? undefined : true);
    expect(rpc).toHaveBeenCalledTimes(pending ? 0 : activation.endsWith(" receipt") ? 2 : 1);
  },
);

it("preserves Windows cold startup within the default update timeout", async () => {
  const readyAtMs = 44 * 60_000;
  const budgetMs = resolveGatewayStartupTiming("win32").deadlineMs;
  gatewayFixture(
    { server: { version: "2026.9.4", bootId: "windows-cold-boot" } },
    { platform: "win32", readyAtMs },
  );
  restart.sleep.mockImplementation(async (delayMs) => {
    // Advance the cold-loading interval without thousands of identical probes.
    restart.monotonicClock.nowMs +=
      restart.monotonicClock.nowMs === 0 ? Math.min(readyAtMs, budgetMs) : delayMs;
  });
  await listen();
  result.after = { version: "2026.9.4" };
  const outcome = await restartGateway({ timeoutMs: 30 * 60_000 });
  expect(outcome).toBe("ok");
  const allowance = expect.objectContaining({ timeoutMs: budgetMs });
  expect(command).toHaveBeenCalledExactlyOnceWith(allowance, "restart");
  expect(restart.monotonicClock.nowMs).toBe(Math.min(readyAtMs, budgetMs));
});

it.each(["unchanged", "readiness-at-deadline", "readyz-error"] as const)(
  "checks final native and HTTP readiness: %s",
  async (transition) => {
    const serving = { version: "2026.9.1", buildId: "candidate-build", bootId: "boot-a" };
    gatewayFixture({ server: serving }, { commandLine: "openclaw-gateway" });
    const reached = createDeferred();
    const release = createDeferred();
    await listen((req, res) => {
      if (req.url === "/readyz") {
        reached.resolve();
        void release.promise.then(() =>
          res.writeHead(transition === "readyz-error" ? 503 : 200).end(),
        );
      } else {
        res.writeHead(200).end();
      }
    });
    const onVerified = vi.fn();
    const verification = verifyGateway({
      opts: withRun("synthetic-update"),
      expectedVersion: "2026.9.1",
      requireRunningService: true,
      onVerified,
    });
    await Promise.race([
      reached.promise,
      verification.then(() => {
        throw new Error("Verifier returned before HTTP readiness");
      }),
    ]);
    expect(rpc).toHaveBeenCalledOnce();
    if (transition.endsWith("at-deadline")) {
      restart.monotonicClock.nowMs = 300_000;
    }
    release.resolve();
    const validation = await verification;
    const verified = transition === "unchanged";
    expect(validation.ok).toBe(verified);
    const deadlineExpired = transition === "readiness-at-deadline";
    if (deadlineExpired || transition === "readyz-error") {
      expect(validation.summary).toBe(deadlineExpired ? "timeout" : "readyz-unhealthy");
      expect(validation.stopReason).toBeUndefined();
      expect(result.steps[0]).toMatchObject({ name: "gateway verification", exitCode: 1 });
    }
    if (deadlineExpired) {
      expect(result.steps[0]?.failureFacts).toContainEqual(
        expect.objectContaining({ code: "timeout" }),
      );
    }
    expect(onVerified).toHaveBeenCalledTimes(verified ? 1 : 0);
  },
);

it.each([true, false, undefined])(
  "completes an update during a channel outage only with core readiness (%s)",
  async (coreReady) => {
    const validation = await verifyHealth(
      { channels: { telegram: { configured: true, running: false } } },
      false,
      true,
      { ready: false, coreReady, failing: ["telegram"] },
    );
    expect(validation.ok).toBe(coreReady === true);
    expect(result.verification).toMatchObject({ readyz: false, channelsReady: false });
    if (coreReady === true) {
      expect(result.steps[0]).toMatchObject({ exitCode: 0 });
      expect(reportFor(result)).toContain("telegram");
      expect(result.verification).toMatchObject({ coreReady: true, settled: true });
    }
  },
);

it.each([false, true])("warns about stopped channels after repair (json=%s)", async (json) => {
  const validation = await verifyHealth(
    {
      channels: {
        telegram: {
          configured: true,
          running: true,
          probe: { ok: true },
          accounts: {
            default: { configured: true, running: true },
            suppressed: {
              configured: true,
              running: false,
              lastError: "restart-loop breaker tripped",
            },
            stopped: { configured: true, running: false },
            disabled: { enabled: false, configured: true, running: false },
            unconfigured: { configured: false, running: false },
          },
        },
        discord: { configured: true, running: false },
      },
    },
    true,
    json,
  );
  expect(validation.ok).toBe(true);
  expect(result.steps[0]).toMatchObject({ exitCode: 0 });
  const report = reportFor(result);
  for (const id of ["telegram/suppressed", "telegram/stopped", "discord"]) {
    expect(report).toContain(id);
  }
  expect(report).toContain("restart-loop breaker tripped");
  expect(report).not.toContain("telegram/disabled");
  expect(report).not.toContain("telegram/unconfigured");
  expect(validation.summary).toContain("channel warnings");
  if (json) {
    expectNoCalls(defaultRuntime.log);
  } else {
    expect(vi.mocked(defaultRuntime.log).mock.calls.flat().join("\n")).toContain(
      "Channel health warning (telegram/suppressed: restart-loop breaker tripped)",
    );
  }
});

const releaseDirs = useAutoCleanupTempDirTracker(afterEach);
async function gitTrial() {
  const { createGitReleaseDirs, publishGitRelease } = await import("../../infra/git-release.js");
  const prefix = path.join(releaseDirs.make("release-verification-"), "git-install");
  for (const version of ["1.0.0", "2.0.0"]) {
    const { releaseRoot } = await createGitReleaseDirs(prefix);
    await fs.mkdir(releaseRoot, { recursive: true });
    const manifest = JSON.stringify({ name: "openclaw", version });
    await fs.writeFile(path.join(releaseRoot, "package.json"), manifest);
    await publishGitRelease({ prefix, releaseRoot, trial: true });
  }
  result.root = gitReleaseSlot(prefix);
  const trial = path.join(prefix, "releases", ".trial");
  await fs.access(trial);
  return trial;
}
it("ends a verified Git release's trial without the release's own settlement", async () => {
  const trial = await gitTrial();
  expect((await verifyHealth({})).ok).toBe(true);
  await expect(fs.access(trial)).rejects.toThrow();
});

const changedPlugins = () => ({
  plugins: createPostCorePluginUpdateResult({ status: "ok", changed: true }),
});
async function gitReleaseRestart() {
  const trial = await gitTrial();
  const identity = { ...candidate, bootId: "candidate-boot" };
  const service = gatewayFixture({ server: identity }, { commandLine: "openclaw-gateway" });
  await listen();
  vi.spyOn(await import("../../utils/sleep.js"), "sleep").mockImplementation(restart.sleep);
  const incumbent = { ...restart.ownerLease(running.pid), port: gatewayPort };
  const successor = { ...restart.ownerLease(8001), port: gatewayPort };
  Object.assign(result, { mode: "git", before: candidate, after: candidate });
  const onVerified = vi.fn();
  const verify = (gitReleaseRestartMode?: RestartParams["gitReleaseRestartMode"]) =>
    restartGateway({
      gitReleaseRestartMode,
      requireRunningServiceAfterRestart: false, // The update did not stop the resident.
      opts: withRun("release-handoff", { assertCurrent: () => controller.signal.throwIfAborted() }),
      timeoutMs: 60_000,
      onVerified,
      serviceUpdateVerdict: {
        kind: "owned",
        root: result.root!,
        fingerprint: "unit",
        refreshDefinition: false,
      },
    });
  const serve = (pid: number) => {
    vi.mocked(service.readRuntime).mockResolvedValue({ status: "running", pid });
    busyPort("openclaw-gateway", 0, pid);
    rpc.mockImplementation(healthResponse(candidate.version, candidate.buildId));
  };
  return { service, incumbent, successor, onVerified, verify, trial, serve };
}

it("does not settle a native Git restart from a listener after the managed service stops", async () => {
  const { service, incumbent, verify, onVerified, trial } = await gitReleaseRestart();
  lease.mockReturnValue(incumbent);
  vi.mocked(service.readRuntime).mockResolvedValue({ status: "stopped" });
  expect(await verify("native")).toBe("restart-health-failed");
  expect(onVerified).not.toHaveBeenCalled();
  await fs.access(trial);
});

it.each([
  ["native", "same", false, "ok"],
  ["absent", "distinct", false, "ok"],
  ["absent", "same", true, "readiness-pending"],
  ["live", "same", false, "readiness-pending"],
  ["live", "distinct", true, "readiness-pending"],
  ["live", "distinct", false, "ok"],
  ["live", "wrong", false, "restart-health-failed"],
] as const)("Git release: %s owner, %s build, plugins=%s", async (owner, target, changed, want) => {
  const { incumbent, onVerified, verify, trial } = await gitReleaseRestart();
  lease.mockReturnValue(owner === "absent" ? undefined : incumbent);
  if (target !== "same") {
    result.before = { ...candidate, buildId: "old-build" };
  }
  if (changed) {
    result.postUpdate = changedPlugins();
  }
  const build = target === "wrong" ? "old-build" : candidate.buildId;
  rpc.mockImplementation(healthResponse(candidate.version, build));
  expect(await verify(owner === "native" ? "native" : undefined)).toBe(want);
  if (owner === "native") {
    expect(command).toHaveBeenCalledExactlyOnceWith(expect.anything(), "restart");
  } else {
    expect(lease).toHaveBeenCalledWith(expect.objectContaining({ current: true }));
    expect(command).not.toHaveBeenCalled();
  }
  expect(onVerified).toHaveBeenCalledTimes(want === "ok" ? 1 : 0);
  expect(vi.mocked(recordUpdateRunVerification).mock.lastCall?.[1]).toMatchObject({
    pid: running.pid,
    runningBuildId: build,
    versionMatch: target !== "wrong",
    readyz: target !== "wrong",
    settled: want === "ok",
  });
  if (want === "readiness-pending") {
    expect(result.steps.at(-1)?.advisory?.message).toContain("restart remains unverified");
  }
  if (want !== "ok") {
    await fs.access(trial);
  }
});

it.each([
  "ready successor",
  "lease for another listener",
  "expired lease",
  "already listening",
  "missing candidate build",
  "mixed listeners",
] as const)(
  "verifies a late Git plugin restart only for the new serving owner: %s",
  async (state) => {
    const { service, incumbent, successor, onVerified, verify, trial } = await gitReleaseRestart();
    result.postUpdate = changedPlugins();
    if (state === "missing candidate build") {
      result.after = { version: candidate.version };
    }
    using now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    lease.mockReturnValue(incumbent);
    // An older resident has no deferral receipt. Its listener changes after the lease
    // wait gave up, just as the ordinary verifier begins inspecting the service.
    vi.mocked(service.readRuntime).mockImplementation(async () => {
      now.mockReturnValue(10_100);
      lease.mockReturnValue({
        ...successor,
        expired: state === "expired lease",
        pid: state === "lease for another listener" ? 8100 : successor.pid,
        listeningAt: state === "already listening" ? 9_000 : 10_050,
      });
      return { status: "running", pid: 9000 };
    });
    const pids = state === "mixed listeners" ? [successor.pid, incumbent.pid] : [successor.pid];
    restart.inspectPortUsage.mockResolvedValue(
      restart.portUsage(
        pids.map((pid) => ({ pid, ppid: 9000 })),
        { port: gatewayPort },
      ),
    );
    const verified = state === "ready successor";
    expect(await verify()).toBe(verified ? "ok" : "readiness-pending");
    expect(onVerified).toHaveBeenCalledTimes(verified ? 1 : 0);
    expect(command).not.toHaveBeenCalled();
    expect(vi.mocked(recordUpdateRunVerification).mock.lastCall?.[1]).toMatchObject({
      readyz: true,
      settled: verified,
    });
    if (verified) {
      await expect(fs.access(trial)).rejects.toThrow();
    } else {
      await fs.access(trial);
    }
  },
);

const conflicts = ["stale", "healthy", "woke", "foreign", "reused", "busy", "leased", "revoked"];
const replacements = ["successor", "unmatched"];
it.each([
  ["changed", "stopped", "free"],
  ["incumbent", "stopped", "free"],
  ["absent", "stopped", "free"],
  ["absent", "unknown", "free"],
  ["incumbent", "unknown", "free"],
  ["absent", "unknown", "stale"],
  ["incumbent", "stopped", "stale"],
  ["absent", "stopped", "masked"],
  ...[...conflicts, ...replacements].map((port) => ["absent", "stopped", port] as const),
] as const)(
  "recovers a switched Git release only after confirmed stop: %s, %s, %s",
  async (owner, status, port) => {
    const { service, incumbent, successor, onVerified, verify, serve } = await gitReleaseRestart();
    using now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const replaces = replacements.includes(port);
    if (replaces) {
      result.postUpdate = changedPlugins();
    }
    lease.mockReturnValueOnce(owner === "absent" ? undefined : incumbent);
    if (owner === "changed") {
      lease.mockReturnValueOnce(successor);
    }
    const refusal = { reason: "masked" as const, message: "test service is masked" };
    const systemd = port === "masked" ? { startRefusal: refusal } : undefined;
    vi.mocked(service.readRuntime).mockResolvedValue({ status, systemd });
    const ancestry = { complete: true, pids: new Set([process.pid]) };
    vi.spyOn(stale, "inspectSelfAndAncestorPidsSync").mockReturnValue(ancestry);
    const setFree = () =>
      restart.inspectPortUsage.mockResolvedValue(restart.portUsage([], { port: gatewayPort }));
    const staleError = new Error("gateway install changed; run: openclaw gateway restart");
    if (port === "free") {
      setFree();
    } else if (port === "woke") {
      rpc.mockRejectedValueOnce(staleError);
    } else if (port !== "healthy") {
      rpc.mockRejectedValue(staleError);
    }
    restart.readActiveGatewayLockIdentity.mockResolvedValue({
      pid: port === "foreign" ? 8001 : running.pid,
      port: gatewayPort,
      startTime: 123,
    });
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(
      port === "reused" ? 456 : 123,
    );
    const cleanup = vi.spyOn(stale, "terminateStaleGatewayPids");
    cleanup.mockImplementation(async (pids, opts) => {
      expect(pids).toEqual([running.pid]);
      if (port === "revoked") {
        controller.abort(new Error("update canceled"));
      }
      opts!.assertCurrent!();
      if (port === "leased") {
        const unknown = { ...successor, state: "unknown" as const };
        lease.mockImplementation((q) => (q?.current ? unknown : undefined));
      }
      if (replaces) {
        now.mockReturnValue(10_100);
        const pid = successor.pid;
        lease.mockReturnValue({
          ...successor,
          listeningAt: 10_050,
          pid: port === "unmatched" ? pid + 1 : pid,
        });
        serve(pid);
      } else if (port !== "busy") {
        setFree();
      }
      return pids;
    });
    const stopped = status === "stopped";
    const cleans =
      stopped && owner === "absent" && (replaces || ["stale", "busy", "leased"].includes(port));
    const recovers = stopped && (port === "free" || (cleans && port === "stale"));
    if (recovers) {
      command.mockImplementationOnce(async () => {
        serve(running.pid);
        return "accepted";
      });
    }
    if (port === "revoked") {
      await expect(verify()).rejects.toThrow("update canceled");
      expect(cleanup).toHaveBeenCalledOnce();
      expectNoCalls(command, onVerified);
      return;
    }
    const failure = port === "masked" ? "reconciliation-pending" : "restart-health-failed";
    const settled = recovers || port === "successor";
    expect(await verify()).toBe(
      settled ? "ok" : port === "unmatched" ? "readiness-pending" : failure,
    );
    expect(cleanup).toHaveBeenCalledTimes(Number(cleans));
    expect(command).toHaveBeenCalledTimes(Number(recovers));
    expect(onVerified).toHaveBeenCalledTimes(Number(settled));
    expect(vi.mocked(recordUpdateRunVerification).mock.calls[0]?.[1]).toMatchObject({
      serviceRunning: replaces ? true : stopped ? false : undefined,
      settled: port === "successor",
    });
  },
);
