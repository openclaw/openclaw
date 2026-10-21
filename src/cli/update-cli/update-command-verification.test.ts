import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveGatewayStartupTiming } from "../../commands/gateway-startup-timing.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import * as gatewayService from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { recordUpdateRunStep, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { readUpdateRunReportHealth } from "../../infra/update-run-report-health.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import { isUpdateRunVerificationConfirmed } from "../../infra/update-run-verification.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as restart from "../daemon-cli/restart-health.test-helpers.js";
import { expectNoCalls } from "./update-boundary.test-support.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import {
  GatewayRestartHealthError,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";
import { maybeRestartService } from "./update-command-service.js";
import { recordUpdatePackageCompletion } from "./update-command-terminal.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-ledger.js")>()),
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
type VerifyParams = Parameters<typeof verifyUpdatedGateway>[0];
type RestartParams = Parameters<typeof maybeRestartService>[0];
function useService(
  runtime: Parameters<typeof restart.makeGatewayService>[0] = { status: "running", pid: 8000 },
) {
  const service = restart.makeGatewayService(runtime);
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
  return service;
}
function busyPort(commandLine?: string, readyAtMs = 0) {
  restart.inspectPortUsage.mockImplementation(async (port) => ({
    port,
    status: restart.monotonicClock.nowMs < readyAtMs ? "free" : "busy",
    listeners:
      restart.monotonicClock.nowMs < readyAtMs
        ? []
        : [{ pid: 8000, ...(commandLine ? { commandLine } : {}) }],
    hints: [],
  }));
}
function gatewayFixture(
  identity: Parameters<typeof gatewayHealthResponse>[0] = {},
  options: { platform?: NodeJS.Platform; commandLine?: string; readyAtMs?: number } = {},
) {
  mockProcessPlatform(options.platform ?? "linux");
  const service = useService();
  busyPort(options.commandLine, options.readyAtMs);
  restart.callGateway.mockImplementation(gatewayHealthResponse(identity));
  return service;
}
function verifyGateway(params: Partial<VerifyParams> = {}) {
  const verification = verifyUpdatedGateway({
    result,
    gatewayPort,
    expectedVersion: candidate.version,
    expectedBuildId: candidate.buildId,
    opts: { json: true },
    serviceEnv,
    signal: controller.signal,
    ...params,
  });
  pendingVerification = verification;
  return verification;
}
function restartGateway(params: Partial<RestartParams> = {}) {
  return maybeRestartService({
    result,
    gatewayPort,
    serviceEnv,
    opts: { json: true },
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
  const service = useService(recovery ? { status: "stopped" } : { status: "running", pid: 8000 });
  if (!recovery) {
    service.isLoaded = vi.fn(async () => true);
  }
  busyPort();
  restart.callGateway.mockImplementation(
    gatewayHealthResponse({
      server: { version, buildId: "candidate", bootId: "candidate-boot" },
      health,
    }),
  );
  Object.assign(
    result,
    recovery ? { status: "error" } : { after: { version, buildId: "candidate" } },
  );
  const onVerified = vi.fn();
  await listen((req, res) =>
    res
      .writeHead(req.url === "/readyz" && readiness ? 503 : 200)
      .end(readiness ? JSON.stringify(readiness) : undefined),
  );
  const validation = await verifyGateway({
    opts: { json },
    expectedVersion: version,
    expectedBuildId: "candidate",
    ...(recovery
      ? ({ purpose: "recovery", waitForStartup: false } as const)
      : { requireRunningService: true, onVerified }),
    ...(readiness ? { purpose: "recovery", waitForStartup: false } : {}),
  });
  return { result, onVerified, validation };
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
  vi.mocked(recordUpdateRunStep).mockReset();
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
    restart.callGateway.mockImplementation(
      state === "starting"
        ? async () => {
            throw new Error("gateway timeout after 3000ms");
          }
        : gatewayHealthResponse({
            server: { version, buildId, bootId: "watcher-successor" },
          }),
    );
    Object.assign(result, {
      mode,
      after: { version: "2026.9.8", buildId: "candidate" },
    });
    await listen();
    const outcome = await restartGateway({
      opts: { json: true, restart: false, run: { runId: "watcher-restart", env: {} } },
      shouldRestart: false,
      requireRunningServiceAfterRestart: undefined,
      observePackageReplacement: true,
      expectedGatewayIdentity:
        state === "retained-identity"
          ? { version: "2026.9.7", buildId: "retained-build" }
          : undefined,
    });
    expect(outcome).toBe("ok");
    expect(runUpdatedInstallGatewayCommand).not.toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.failureFacts).toBeUndefined();
    expect(result.steps[0]?.termination).toBeUndefined();
    expect(result.steps[0]?.advisory?.message).toEqual(
      verified ? undefined : expect.stringContaining("--no-restart"),
    );
    expect(recordUpdateRunVerification).toHaveBeenCalledWith(
      "watcher-restart",
      expect.objectContaining({
        versionMatch: state === "starting" ? undefined : verified,
      }),
      expect.anything(),
    );
    const facts = vi.mocked(recordUpdateRunVerification).mock.calls.at(-1)?.[1];
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
    let probes = 0;
    restart.callGateway.mockImplementation((opts) =>
      gatewayHealthResponse({
        server: { version: "2026.9.8", buildId: "candidate", bootId: "candidate-boot" },
        health: {
          channels: {
            telegram: {
              probe:
                kind === "transient-timeout" && probes++ > 0
                  ? { ok: true }
                  : {
                      ok: false,
                      timedOut: true,
                      error: "health collection timed out after 7000ms",
                    },
            },
            ...(kind === "mixed"
              ? { discord: { probe: { ok: false, error: "invalid credentials" } } }
              : {}),
          },
        },
      })(opts),
    );
    await listen();
    const onVerified = vi.fn();
    const verification = await verifyGateway({
      opts: { json: true, run: { runId: "collection-timeout", env: {} } },
      expectedVersion: "2026.9.8",
      expectedBuildId: "candidate",
      requireRunningService: true,
      onVerified,
    });
    expect(verification.ok).toBe(true);
    expect(onVerified).toHaveBeenCalledOnce();
    expect(result.steps[0]?.exitCode).toBe(0);
    expect(recordUpdateRunVerification).toHaveBeenCalledWith(
      "collection-timeout",
      expect.objectContaining({
        serviceRunning: true,
        versionMatch: true,
        readyz: true,
        settled: true,
        channelsReady: false,
      }),
      expect.anything(),
    );
    const facts = vi.mocked(recordUpdateRunVerification).mock.calls.at(-1)?.[1];
    expect(facts && isUpdateRunVerificationConfirmed(facts)).toBe(true);
    expect(renderUpdateRunReport(updateRunReportInputFromResult(result)).markdown).toContain(
      "telegram: health collection timed out after 7000ms",
    );
    expect(result.steps[0]?.warnings?.join("\n")).toContain(
      "telegram: health collection timed out after 7000ms",
    );
    expect(recordUpdateRunStep).toHaveBeenCalledWith(
      "collection-timeout",
      expect.objectContaining({ step: "warning:gateway verification", status: "completed" }),
      expect.anything(),
    );
  },
);

it.each(["slow inspection", "hung readiness"] as const)(
  "bounds foreground recovery observation with %s",
  async (fault) => {
    const hung = fault === "hung readiness";
    const service = useService({ status: "stopped" });
    if (!hung) {
      vi.mocked(service.readCommand).mockImplementation(async () => {
        restart.monotonicClock.nowMs += 3_300;
        return null;
      });
    }
    vi.mocked(service.readRuntime).mockResolvedValue({ status: "unknown" });
    busyPort();
    restart.callGateway.mockImplementation((opts) => {
      const responseMs = 5;
      if (!hung && (opts.timeoutMs ?? responseMs) < responseMs) {
        throw new Error("Gateway health response exceeded its remaining allowance");
      }
      return gatewayHealthResponse({
        server: {
          version: "2026.9.5",
          ...(hung ? {} : { buildId: "installed-build" }),
          bootId: "foreground-boot",
        },
      })(opts);
    });
    const requests: string[] = [];
    await listen((req, res) => {
      requests.push(req.url ?? "");
      if (!hung || req.url === "/healthz") {
        res.writeHead(200).end();
      }
    });
    Object.assign(result, {
      status: "error",
      ...(hung ? {} : { reason: "doctor-failed" }),
    });
    const startedAt = Date.now();
    const verification = verifyGateway({
      purpose: "recovery",
      expectedVersion: "2026.9.5",
      expectedBuildId: hung ? undefined : "installed-build",
      waitForStartup: false,
      timeoutMs: hung ? 30 * 60_000 : 30_000,
    });
    if (!hung) {
      expect(await verification).toMatchObject({ ok: true });
      expect(requests.toSorted()).toEqual(["/healthz", "/readyz"]);
      expect(restart.callGateway).toHaveBeenCalledTimes(2);
      expect(restart.monotonicClock.nowMs).toBe(6_600);
      expect(restart.sleep).not.toHaveBeenCalled();
      for (const [params] of restart.callGateway.mock.calls) {
        expect(params.timeoutMs).toBe(3_000);
      }
      expect(result).toMatchObject({ status: "error", reason: "doctor-failed" });
      expect(result.verification?.serviceRunning).toBeUndefined();
      expect(result.verification?.readyz).toBe(true);
      expect(result.steps[0]?.exitCode).toBe(0);
      expect(result.steps[0]?.termination).toBeUndefined();
      return;
    }
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
    for (const [params] of restart.callGateway.mock.calls) {
      expect(params.timeoutMs).toBeLessThanOrEqual(3_000);
    }
  },
);

it.each(["first read", "after listener observation", "recovery"])(
  "records expired readiness work before it settles (%s)",
  async (phase) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockProcessPlatform("linux");
    const entered = createDeferred();
    const released = createDeferred<GatewayServiceRuntime>();
    const service = useService();
    let readRuntime = false;
    vi.mocked(service.readRuntime).mockImplementation(() => {
      if (phase === "after listener observation" && !readRuntime) {
        readRuntime = true;
        return Promise.resolve({ status: "running", pid: 8000 });
      }
      entered.resolve();
      return released.promise;
    });
    const onVerified = vi.fn();
    const lateMutation = vi.fn();
    const recoverHealth: Parameters<typeof verifyUpdatedGateway>[0]["recoverHealth"] =
      phase === "recovery"
        ? async (health, _reinspect, assertCurrent) => {
            entered.resolve();
            await released.promise;
            assertCurrent();
            lateMutation();
            return { health, launchAgentRecovery: null };
          }
        : undefined;
    const settle = vi.fn();
    pendingVerification = verifyGateway({
      opts: { json: true, run: { runId: "stalled-readiness", env: {} } },
      expectedBuildId: undefined,
      requireRunningService: true,
      timeoutMs: 1_000,
      onVerified,
      recoverHealth,
      health:
        phase === "recovery"
          ? {
              healthy: false,
              waitOutcome: "stopped-free",
              runtime: { status: "stopped" },
              portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
              staleGatewayPids: [],
            }
          : undefined,
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
      released.resolve({ status: "running", pid: 8000 });
      await vi.advanceTimersByTimeAsync(0);
      expectNoCalls(onVerified, lateMutation);
    } finally {
      controller.abort();
      released.resolve({ status: "running", pid: 8000 });
      await pendingVerification;
      vi.useRealTimers();
    }
  },
);

it("prefers a pending recovery observation over previously saved healthy facts", async () => {
  result.status = "error";
  await expect(
    verifyGateway({
      opts: { json: true, run: { runId: "pending-recovery", env: {} } },
      purpose: "recovery",
      gatewayPort: 19101,
      expectedVersion: "2026.9.5",
      expectedBuildId: undefined,
      health: {
        healthy: false,
        waitOutcome: "still-starting",
        runtime: { status: "running", pid: 8000 },
        portUsage: { port: 19101, status: "free", listeners: [], hints: [] },
        staleGatewayPids: [],
      },
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
      opts: { json: true, run: { runId: "observed-recovery", env: {} } },
      purpose: "recovery",
      expectedVersion: "2026.9.5",
    });
    await expect(verification).rejects.toBe(cleanup);
    expect(result.verification).toBeUndefined();
    expect(result.steps).toEqual([]);
  },
);

it.each([
  [1_500, 1_500, 1_000, false, 1_000, 1_500],
  [12_500, 20_000, undefined, true, 20_000, 21_500],
] as const)(
  "keeps readiness within the startup allowance (startup=%s)",
  async (startupAtMs, healthyAtMs, timeoutMs, verified, minMs, maxMs) => {
    gatewayFixture({}, { readyAtMs: startupAtMs });
    restart.callGateway.mockImplementation(async (opts) => {
      const responseMs = 5;
      const remainingMs = opts.timeoutMs ?? responseMs;
      restart.monotonicClock.nowMs += Math.min(responseMs, remainingMs);
      if (restart.monotonicClock.nowMs < healthyAtMs) {
        throw new Error("Gateway is still starting");
      }
      if (remainingMs < responseMs) {
        throw new Error("Gateway health response exceeded its remaining allowance");
      }
      return gatewayHealthResponse({
        server: { version: "2026.9.4", buildId: "candidate-build", bootId: "settling-boot" },
      })(opts);
    });
    let httpRequests = 0;
    await listen((_req, res) => {
      httpRequests++;
      res.writeHead(200).end();
    });
    const verification = verifyGateway({ requireRunningService: true, timeoutMs });
    expect((await verification).ok).toBe(verified);
    expect(httpRequests).toBe(verified ? 2 : 0);
    expect(restart.monotonicClock.nowMs).toBeGreaterThanOrEqual(minMs);
    expect(restart.monotonicClock.nowMs).toBeLessThan(maxMs);
  },
);

it.each([
  { activation: "native restart", exhausted: true },
  { activation: "service refresh", exhausted: false },
  { activation: "service refresh", exhausted: true },
  { activation: "child readiness timeout", exhausted: true },
])(
  "preserves a slow startup ($activation, exhausted=$exhausted)",
  async ({ activation, exhausted }) => {
    const refreshServiceEnv = activation === "service refresh";
    const childTimeout = activation === "child readiness timeout";
    if (childTimeout) {
      vi.mocked(runUpdatedInstallGatewayCommand).mockImplementationOnce(async () => {
        restart.monotonicClock.nowMs = 60_000;
        throw new GatewayRestartHealthError(
          "Gateway restart timed out after 60s waiting for health checks.",
        );
      });
    }
    gatewayFixture(
      {
        server: { version: "2026.9.4", buildId: "candidate-build", bootId: "slow-boot" },
      },
      { readyAtMs: 90_000 },
    );
    await listen();
    result.after = { ...candidate };
    const outcome = await restartGateway({
      refreshServiceEnv,
      timeoutMs: exhausted ? 60_000 : 120_000,
    });
    const pending = exhausted && !childTimeout;
    expect(outcome, JSON.stringify(vi.mocked(defaultRuntime.error).mock.calls)).toBe(
      pending ? "readiness-pending" : "ok",
    );
    expect(restart.monotonicClock.nowMs).toBe(pending ? 60_000 : 90_000);
    expect(restart.callGateway).toHaveBeenCalledTimes(pending ? 0 : 2);
    expect(runUpdatedInstallGatewayCommand).toHaveBeenCalledOnce();
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
  const outcome = await restartGateway({
    opts: { json: true, timeout: undefined },
    timeoutMs: 30 * 60_000,
  });

  expect(outcome).toBe("ok");
  expect(runUpdatedInstallGatewayCommand).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ timeoutMs: budgetMs }),
    "restart",
  );
  expect(restart.monotonicClock.nowMs).toBe(Math.min(readyAtMs, budgetMs));
});

it.each([
  { transition: "unchanged", supplied: false },
  { transition: "unchanged", supplied: true },
  { transition: "readiness-at-deadline", supplied: false },
  { transition: "first-final-health-error", supplied: false },
  { transition: "readyz-error", supplied: false },
] as const)(
  "checks final native and HTTP readiness: $transition, supplied=$supplied",
  async ({ transition, supplied }) => {
    const service = gatewayFixture({}, { commandLine: "openclaw-gateway" });
    service.isLoaded = vi.fn(async () => true);
    restart.callGateway.mockImplementation((opts) =>
      gatewayHealthResponse({
        server: { version: "2026.9.1", buildId: "candidate-build", bootId: "boot-a" },
        ...(transition === "first-final-health-error" && restart.callGateway.mock.calls.length === 2
          ? { error: new Error("synthetic health failed") }
          : {}),
      })(opts),
    );
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
    const probeParams = {
      service,
      port: gatewayPort,
      env: serviceEnv,
      expectedVersion: "2026.9.1",
      expectedBuildId: "candidate-build",
      requireRunningService: true,
      signal: controller.signal,
    };
    const { waitForGatewayHealthyRestart } = await import("../daemon-cli/restart-health.js");
    const health = supplied ? await waitForGatewayHealthyRestart(probeParams) : undefined;
    const onVerified = vi.fn();
    const verification = verifyGateway({
      opts: { json: true, run: { runId: "synthetic-update", env: {} } },
      health,
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
    expect(restart.callGateway).toHaveBeenCalledOnce();
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
      expect(result.steps).toContainEqual(
        expect.objectContaining({ name: "gateway verification", exitCode: 1 }),
      );
    }
    if (deadlineExpired) {
      expect(result.steps[0]?.exitCode).toBe(1);
      expect(result.steps[0]?.failureFacts).toContainEqual(
        expect.objectContaining({ code: "timeout" }),
      );
      expect(restart.callGateway).toHaveBeenCalledOnce();
    }
    expect(onVerified).toHaveBeenCalledTimes(verified ? 1 : 0);
    if (verified) {
      expect(recordUpdateRunVerification).toHaveBeenLastCalledWith(
        "synthetic-update",
        expect.objectContaining({
          pid: 8000,
          settled: true,
          readyz: true,
        }),
        expect.anything(),
      );
    } else {
      expect(recordUpdateRunVerification).not.toHaveBeenCalledWith(
        "synthetic-update",
        expect.objectContaining({ settled: true, readyz: true }),
        expect.anything(),
      );
    }
  },
);

it.each([true, false, undefined])(
  "completes an update during a channel outage only with core readiness (%s)",
  async (coreReady) => {
    const { validation } = await verifyHealth(
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

it.each(["channel probe", "plugin load"] as const)(
  "completes verified activation with a named warning (%s)",
  async (fault) => {
    const { validation, onVerified } = await verifyHealth({
      channels:
        fault === "channel probe"
          ? { whatsapp: { probe: { ok: false, error: "re-pair required" } } }
          : {},
      ...(fault === "plugin load"
        ? {
            plugins: { errors: [{ id: "whatsapp", activated: true, error: "dependency missing" }] },
          }
        : {}),
    });
    expect(validation).toMatchObject({ ok: true, score: 7 });
    if (fault === "plugin load") {
      expect(validation.summary).toBe(
        "Gateway service, version, channels, and readiness verified; plugin failures need a retry.",
      );
      expect(validation.pluginWarnings).toEqual([
        expect.objectContaining({
          pluginId: "whatsapp",
          reason: "dependency missing",
          message:
            'Plugin "whatsapp" could not be loaded. Run `openclaw doctor --fix` to check and repair the load problem.',
          guidance: ["openclaw doctor --fix"],
        }),
      ]);
    } else {
      expect(validation.summary).toContain("channel warnings need attention");
      expect(validation.pluginWarnings).toBeUndefined();
    }
    expect(onVerified).toHaveBeenCalledOnce();
    expect(result.steps[0]).toMatchObject({ exitCode: 0 });
    expect(result.steps[0]?.failureFacts).toBeUndefined();
    const complete = vi.fn<PackageUpdateTransaction["complete"]>(async () => undefined);
    await expect(
      recordUpdatePackageCompletion(
        {
          root: "/synthetic-package",
          opts: { json: true },
          packageTransaction: { backupRoot: "/synthetic-backup", complete, rollback: vi.fn() },
        },
        result,
        () => {},
      ),
    ).resolves.toBeUndefined();
    expect(complete).toHaveBeenCalledExactlyOnceWith(
      { activationVerified: true },
      expect.any(Function),
    );
    const report = reportFor(result);
    if (fault === "channel probe") {
      expect(report).toContain("whatsapp: re-pair required");
      expect(report).toContain("openclaw channels status --probe");
      expect(report).toContain("openclaw health --json");
    }
    expect(report).not.toContain("restart remains unsafe");
  },
);

it.each([false, true])("warns about stopped channels after repair (json=%s)", async (json) => {
  const { validation } = await verifyHealth(
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
