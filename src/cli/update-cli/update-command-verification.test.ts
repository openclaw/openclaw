import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveGatewayStartupTiming } from "../../commands/gateway-startup-timing.js";
import * as gatewayService from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
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
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as restart from "../daemon-cli/restart-health.test-helpers.js";
import { expectNoCalls } from "./update-boundary.test-support.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
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
type VerifyParams = Parameters<typeof verifyUpdatedGateway>[0];
type RestartParams = Parameters<typeof maybeRestartService>[0];
const withRun = (runId: string) => ({ json: true, run: { runId, env: {} } });
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
  const service = useService(recovery ? { status: "stopped" } : running);
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
  await listen((req, res) =>
    res
      .writeHead(req.url === "/readyz" && readiness ? 503 : 200)
      .end(readiness ? JSON.stringify(readiness) : undefined),
  );
  const validation = await verifyGateway({
    opts: { json },
    expectedVersion: version,
    expectedBuildId: "candidate",
    requireRunningService: !recovery,
    purpose: "recovery",
    waitForStartup: false,
  });
  return { result, validation };
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
    restart.callGateway.mockImplementation(
      state === "starting"
        ? async () => {
            throw new Error("gateway timeout after 3000ms");
          }
        : healthResponse(version, buildId, "watcher-successor"),
    );
    Object.assign(result, {
      mode,
      after: { version: "2026.9.8", buildId: "candidate" },
    });
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
    expect(runUpdatedInstallGatewayCommand).not.toHaveBeenCalled();
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
    expect(result.steps[0]?.exitCode).toBe(0);
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
    expect(result.steps[0]?.warnings?.join("\n")).toContain(
      "telegram: health collection timed out after 7000ms",
    );
  },
);

it("bounds foreground recovery observation with hung readiness", async () => {
  const service = useService({ status: "stopped" });
  vi.mocked(service.readRuntime).mockResolvedValue({ status: "unknown" });
  busyPort();
  restart.callGateway.mockImplementation(healthResponse("2026.9.5", undefined, "foreground-boot"));
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
  for (const [params] of restart.callGateway.mock.calls) {
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
    const mismatch = restart.gatewayProtocolMismatchError();
    restart.callGateway.mockRejectedValue(mismatch);
    const inspecting = createDeferred();
    let completedInspections = observed ? 1 : 0;
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
      ? `${deadline} Last health probe: protocol mismatch: Control UI v5, Gateway v4, connection check min v3`
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
    gatewayFixture({ server: { ...candidate, bootId: "slow-boot" } }, { readyAtMs: 90_000 });
    await listen();
    if (activation.includes("receipt")) {
      vi.mocked(runUpdatedInstallGatewayCommand).mockImplementationOnce(async ({ onReadiness }) => {
        const { waitForGatewayHealthyRestart } = await import("../daemon-cli/restart-health.js");
        const health = await waitForGatewayHealthyRestart({
          service: gatewayService.resolveGatewayService(),
          port: gatewayPort,
          env: serviceEnv,
          timeoutMs: 120_000,
        });
        if (activation === "mismatched receipt") {
          health.gatewayBuildId = "previous-build";
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
    expect(restart.callGateway).toHaveBeenCalledTimes(
      pending ? 0 : activation === "mismatched receipt" ? 2 : 1,
    );
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

it.each(["unchanged", "readiness-at-deadline", "readyz-error"] as const)(
  "checks final native and HTTP readiness: %s",
  async (transition) => {
    gatewayFixture({}, { commandLine: "openclaw-gateway" });
    restart.callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.9.1", buildId: "candidate-build", bootId: "boot-a" },
      }),
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
