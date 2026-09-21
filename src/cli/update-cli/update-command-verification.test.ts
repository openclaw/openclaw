import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import * as gatewayService from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { recordUpdateRunStep, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { readUpdateRunReportHealth } from "../../infra/update-run-report-health.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  monotonicClock,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
} from "../daemon-cli/restart-health.test-helpers.js";
import {
  GatewayRestartHealthError,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";
import { maybeRestartService } from "./update-command-service.js";
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
vi.mock("./restart-helper.js", () => ({ runRestartScript: vi.fn(async () => true) }));
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
beforeEach(() => {
  controller = new AbortController();
  pendingVerification = undefined;
  vi.clearAllMocks();
  vi.mocked(recordUpdateRunVerification).mockReset();
  vi.mocked(recordUpdateRunStep).mockReset();
  resetRestartHealthMocks();
});
afterEach(async () => {
  controller.abort();
  await pendingVerification?.catch(() => {});
  restoreRestartHealthMocks();
  server?.closeAllConnections();
  if (server?.listening) {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

describe("update readiness generation", () => {
  it("prefers a pending recovery observation over previously saved healthy facts", async () => {
    const result: UpdateRunResult = { status: "error", mode: "npm", steps: [], durationMs: 0 };
    await expect(
      verifyUpdatedGateway({
        result,
        opts: { json: true, run: { runId: "pending-recovery", env: {} } },
        purpose: "recovery",
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort: 19101,
        expectedVersion: "2026.9.5",
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

  it.each(["none", "runtime", "port", "command"] as const)(
    "keeps recovery observation factual with inspection cleanup: %s",
    async (fault) => {
      mockProcessPlatform("linux");
      const service = makeGatewayService({ status: "running", pid: 8000 });
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000 }],
        hints: [],
      }));
      callGateway.mockImplementation(
        gatewayHealthResponse({
          server: { version: "2026.9.5", buildId: "candidate-build", bootId: "recovery-boot" },
        }),
      );
      server = createServer((_req, res) => res.writeHead(200).end());
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing loopback listener");
      }
      const cleanup = new AggregateError(
        [new CommandProcessCleanupError()],
        "inspection cleanup uncertain",
      );
      if (fault === "runtime") {
        vi.spyOn(service, "readRuntime").mockRejectedValue(cleanup);
      }
      if (fault === "command") {
        vi.spyOn(service, "readCommand").mockRejectedValue(cleanup);
      }
      if (fault === "port") {
        inspectPortUsage.mockRejectedValue(cleanup);
      }
      const result: UpdateRunResult = {
        status: "error",
        mode: "npm",
        reason: "post-update-plugins",
        steps: [],
        durationMs: 0,
      };
      const verification = verifyUpdatedGateway({
        result,
        opts: { json: true, run: { runId: "observed-recovery", env: {} } },
        purpose: "recovery",
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort: address.port,
        expectedVersion: "2026.9.5",
        expectedBuildId: "candidate-build",
        signal: controller.signal,
      });
      pendingVerification = verification;
      if (fault !== "none") {
        await expect(verification).rejects.toBe(cleanup);
        expect(result.verification).toBeUndefined();
        expect(result.steps).toEqual([]);
        return;
      }
      await expect(verification).resolves.toMatchObject({ ok: true });
      expect(result).toMatchObject({ status: "error", reason: "post-update-plugins" });
      expect(result.steps).toContainEqual(
        expect.objectContaining({ name: "gateway recovery verification", exitCode: 0 }),
      );
      expect(
        result.steps.some((step) =>
          step.failureFacts?.some((fact) => fact.code === "gateway-probe-failed"),
        ),
      ).toBe(false);
      expect(result.verification).toMatchObject({
        runningVersion: "2026.9.5",
        runningBuildId: "candidate-build",
        readyz: true,
        settled: true,
        versionMatch: true,
      });
      expect(recordUpdateRunVerification).not.toHaveBeenCalled();
      expect(recordUpdateRunStep).not.toHaveBeenCalled();
    },
  );

  it.each(["still-starting", "stopped-free"] as const)(
    "preserves the readiness owner's bounded verdict (%s)",
    async (waitOutcome) => {
      const recoverHealth = vi.fn<
        NonNullable<Parameters<typeof verifyUpdatedGateway>[0]["recoverHealth"]>
      >(async (health) => ({ health, launchAgentRecovery: null }));
      const result: UpdateRunResult = { status: "ok", mode: "npm", steps: [], durationMs: 0 };
      const verification = await verifyUpdatedGateway({
        result,
        opts: { json: true, run: { runId: "bounded-startup", env: {} } },
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort: 18789,
        expectedVersion: "2026.9.4",
        requireRunningService: true,
        health: {
          healthy: false,
          waitOutcome,
          runtime: { status: waitOutcome === "still-starting" ? "running" : "stopped", pid: 8000 },
          portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
          staleGatewayPids: [],
          expectedVersion: "2026.9.4",
          startupPhase: "loading plugins",
          elapsedMs: 300_000,
        },
        recoverHealth,
      });
      expect(verification).toMatchObject(
        waitOutcome === "still-starting"
          ? { ok: false, stopReason: "still-starting" }
          : { ok: false, summary: "service-not-running" },
      );
      expect(recoverHealth).toHaveBeenCalledTimes(waitOutcome === "still-starting" ? 0 : 1);
      expect(result.steps[0]?.exitCode).toBe(waitOutcome === "still-starting" ? 0 : 1);
      expect(recordUpdateRunVerification).toHaveBeenLastCalledWith(
        "bounded-startup",
        expect.objectContaining({ versionMatch: undefined }),
        expect.anything(),
      );
    },
  );

  it.each([
    {
      startupAtMs: 0,
      healthyAtMs: 0,
      timeoutMs: 1_000,
      verified: true,
      minMs: 5_500,
      maxMs: 6_500,
    },
    {
      startupAtMs: 1_500,
      healthyAtMs: 1_500,
      timeoutMs: 1_000,
      verified: false,
      minMs: 6_500,
      maxMs: 7_000,
    },
    {
      startupAtMs: 12_500,
      healthyAtMs: 20_000,
      timeoutMs: undefined,
      verified: true,
      minMs: 25_500,
      maxMs: 27_000,
    },
  ])(
    "includes settling once without extending the startup allowance (startup=$startupAtMs)",
    async ({ startupAtMs, healthyAtMs, timeoutMs, verified, minMs, maxMs }) => {
      mockProcessPlatform("linux");
      const service = makeGatewayService({ status: "running", pid: 8000 });
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: monotonicClock.nowMs < startupAtMs ? "free" : "busy",
        listeners: monotonicClock.nowMs < startupAtMs ? [] : [{ pid: 8000 }],
        hints: [],
      }));
      callGateway.mockImplementation(async (opts) => {
        const responseMs = 5;
        const remainingMs = opts.timeoutMs ?? responseMs;
        monotonicClock.nowMs += Math.min(responseMs, remainingMs);
        if (monotonicClock.nowMs < healthyAtMs) {
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
      server = createServer((_req, res) => {
        httpRequests++;
        res.writeHead(200).end();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing loopback listener");
      }
      const verification = verifyUpdatedGateway({
        result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
        opts: { json: true },
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort: address.port,
        expectedVersion: "2026.9.4",
        expectedBuildId: "candidate-build",
        requireRunningService: true,
        timeoutMs,
        signal: controller.signal,
      });
      pendingVerification = verification;
      expect((await verification).ok).toBe(verified);
      expect(httpRequests).toBe(verified ? 2 : 0);
      expect(monotonicClock.nowMs).toBeGreaterThanOrEqual(minMs);
      expect(monotonicClock.nowMs).toBeLessThan(maxMs);
    },
  );

  it.each(["stable", "pid storm", "boot storm"])(
    "only preserves stable startup at the deadline: %s",
    async (startup) => {
      mockProcessPlatform("linux");
      const service = makeGatewayService({ status: "running", pid: 8000 });
      vi.mocked(service.readRuntime).mockImplementation(async () => ({
        status: "running",
        pid: startup === "pid storm" ? 8000 + monotonicClock.nowMs / 500 : 8000,
      }));
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      if (startup === "boot storm") {
        inspectPortUsage.mockImplementation(async (port) => ({
          port,
          status: "busy",
          listeners: [{ pid: 8000 }],
          hints: [],
        }));
        callGateway.mockImplementation((opts) =>
          gatewayHealthResponse({
            server: { version: "2026.9.4", bootId: `boot-${monotonicClock.nowMs}` },
          })(opts),
        );
      }
      const recoverHealth = vi.fn<
        NonNullable<Parameters<typeof verifyUpdatedGateway>[0]["recoverHealth"]>
      >(async (health) => ({ health, launchAgentRecovery: null }));
      const updateResult: UpdateRunResult = { status: "ok", mode: "npm", steps: [], durationMs: 0 };
      const result = await verifyUpdatedGateway({
        result: updateResult,
        opts: { json: true },
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort: 18789,
        expectedVersion: "2026.9.4",
        requireRunningService: true,
        timeoutMs: 1_000,
        recoverHealth,
      });
      expect(result).toMatchObject(
        startup === "stable"
          ? { stopReason: "gateway-readiness-pending" }
          : { ok: false, summary: "generation-changed" },
      );
      if (startup !== "stable") {
        expect(result.stopReason).toBeUndefined();
      }
      expect(recoverHealth).toHaveBeenCalledTimes(startup === "stable" ? 0 : 1);
      expect(updateResult.steps[0]?.exitCode).toBe(startup === "stable" ? 0 : 1);
    },
  );

  it.each(
    [
      "restart script",
      "service refresh",
      "child readiness timeout",
      "legacy update marker",
    ].flatMap((activation) => [false, true].map((exhausted) => ({ activation, exhausted }))),
  )(
    "preserves a slow startup ($activation, exhausted=$exhausted)",
    async ({ activation, exhausted }) => {
      const refreshServiceEnv = activation === "service refresh";
      const childTimeout = activation === "child readiness timeout";
      if (childTimeout) {
        vi.mocked(runUpdatedInstallGatewayCommand).mockImplementationOnce(async () => {
          monotonicClock.nowMs = 60_000;
          throw new GatewayRestartHealthError(
            "Gateway restart timed out after 60s waiting for health checks.",
          );
        });
      }
      mockProcessPlatform("linux");
      const service = makeGatewayService({ status: "running", pid: 8000 });
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: monotonicClock.nowMs < 90_000 ? "free" : "busy",
        listeners: monotonicClock.nowMs < 90_000 ? [] : [{ pid: 8000 }],
        hints: [],
      }));
      callGateway.mockImplementation(
        gatewayHealthResponse({
          server: { version: "2026.9.4", buildId: "candidate-build", bootId: "slow-boot" },
        }),
      );
      server = createServer((_req, res) => res.writeHead(200).end());
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing loopback listener");
      }
      const result =
        activation === "legacy update marker"
          ? await verifyUpdatedGateway({
              result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
              opts: { json: true },
              serviceEnv: { HOME: "/synthetic-home", OPENCLAW_UPDATE_IN_PROGRESS: "1" },
              gatewayPort: address.port,
              expectedVersion: "2026.9.4",
              expectedBuildId: "candidate-build",
              requireRunningService: true,
              ...(exhausted ? { timeoutMs: 60_000 } : {}),
            })
          : await maybeRestartService({
              shouldRestart: true,
              result: {
                status: "ok",
                mode: "npm",
                steps: [],
                durationMs: 0,
                after: { version: "2026.9.4", buildId: "candidate-build" },
              },
              opts: { json: true },
              refreshServiceEnv,
              serviceEnv: { HOME: "/synthetic-home" },
              gatewayPort: address.port,
              restartScriptPath: childTimeout ? undefined : "/synthetic-restart.sh",
              requireRunningServiceAfterRestart: true,
              timeoutMs: exhausted ? 60_000 : 120_000,
            });
      const pending = exhausted && !childTimeout;
      if (typeof result === "string") {
        expect(result, JSON.stringify(vi.mocked(defaultRuntime.error).mock.calls)).toBe(
          pending ? "readiness-pending" : "ok",
        );
      } else {
        expect(result).toMatchObject(
          pending ? { ok: false, stopReason: "gateway-readiness-pending" } : { ok: true },
        );
      }
      expect(monotonicClock.nowMs).toBe(pending ? 65_500 : 95_500);
      expect(callGateway).toHaveBeenCalledTimes(pending ? 0 : 14);
      const { runRestartScript } = await import("./restart-helper.js");
      expect(runRestartScript).toHaveBeenCalledTimes(
        refreshServiceEnv || childTimeout || activation === "legacy update marker" ? 0 : 1,
      );
      expect(runUpdatedInstallGatewayCommand).toHaveBeenCalledTimes(
        refreshServiceEnv || childTimeout ? 1 : 0,
      );
    },
  );

  it.each([
    { transition: "unchanged", supplied: false },
    { transition: "replacement", supplied: false },
    { transition: "replacement-at-deadline", supplied: false },
    { transition: "unchanged-at-deadline", supplied: false },
    { transition: "same-pid-new-boot", supplied: false },
    { transition: "replacement-during-final-health", supplied: false },
    { transition: "same-pid-new-boot-during-native", supplied: false },
    { transition: "pidless-new-boot-during-native", supplied: false },
    { transition: "unchanged-pidless", supplied: false },
    { transition: "first-final-health-error", supplied: false },
    { transition: "last-final-health-error", supplied: false },
    { transition: "readyz-error", supplied: false },
    { transition: "unchanged", supplied: true },
    { transition: "replacement", supplied: true },
  ] as const)(
    "binds final readiness to the settled generation: $transition, supplied=$supplied",
    async ({ transition, supplied }) => {
      // Keep the real settle, health/hello interpretation and HTTP readiness loop.
      // Only the service manager/health RPC are synthetic; HTTP uses a local socket.
      const pidless = transition.includes("pidless");
      const unchanged = transition.startsWith("unchanged");
      if (pidless) {
        mockProcessPlatform("win32");
      }
      let runtime: GatewayServiceRuntime = { status: "running", ...(pidless ? {} : { pid: 8000 }) };
      let bootId = "boot-a";
      const service = makeGatewayService({ status: "running", pid: 8000 });
      vi.mocked(service.readRuntime).mockImplementation(async () => {
        if (transition.endsWith("during-native") && callGateway.mock.calls.length === 13) {
          bootId = "boot-b";
        }
        return { ...runtime };
      });
      service.isLoaded = vi.fn(async () => true);
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: runtime.pid, commandLine: "openclaw-gateway" }],
        hints: [],
      }));
      callGateway.mockImplementation(async (opts) => {
        const response = await gatewayHealthResponse({
          server: { version: "2026.9.1", buildId: "candidate-build", bootId },
          ...((transition === "first-final-health-error" && callGateway.mock.calls.length === 13) ||
          (transition === "last-final-health-error" && callGateway.mock.calls.length === 14)
            ? { error: new Error("synthetic health failed") }
            : {}),
        })(opts);
        if (
          transition === "replacement-during-final-health" &&
          callGateway.mock.calls.length > 12
        ) {
          runtime = { status: "running", pid: 8001 };
        }
        return response;
      });
      const reached = createDeferred();
      const release = createDeferred();
      server = createServer((req, res) => {
        if (req.url === "/readyz") {
          reached.resolve();
          void release.promise.then(() =>
            res.writeHead(transition === "readyz-error" ? 503 : 200).end(),
          );
        } else {
          res.writeHead(200).end();
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing loopback listener");
      }
      const probeParams = {
        service,
        port: address.port,
        env: { HOME: "/synthetic-home" },
        expectedVersion: "2026.9.1",
        expectedBuildId: "candidate-build",
        requireRunningService: true,
        settle: { probes: 12 },
        signal: controller.signal,
      };
      const { waitForGatewayHealthyRestart } = await import("../daemon-cli/restart-health.js");
      const health = supplied ? await waitForGatewayHealthyRestart(probeParams) : undefined;
      const onVerified = vi.fn();
      const updateResult: UpdateRunResult = { status: "ok", mode: "npm", steps: [], durationMs: 0 };
      const verification = verifyUpdatedGateway({
        result: updateResult,
        opts: { json: true, run: { runId: "synthetic-update", env: {} } },
        serviceEnv: probeParams.env,
        signal: controller.signal,
        health,
        gatewayPort: address.port,
        expectedVersion: "2026.9.1",
        expectedBuildId: "candidate-build",
        requireRunningService: true,
        onVerified,
      });
      pendingVerification = verification;
      await Promise.race([
        reached.promise,
        verification.then(() => {
          throw new Error("Verifier returned before HTTP readiness");
        }),
      ]);
      expect(callGateway).toHaveBeenCalledTimes(12);
      if (transition.startsWith("replacement") || transition === "same-pid-new-boot") {
        bootId = "boot-b";
        runtime = { status: "running", pid: transition.startsWith("replacement") ? 8001 : 8000 };
      }
      if (transition.endsWith("at-deadline")) {
        monotonicClock.nowMs = 305_500;
      }
      release.resolve();
      const result = await verification;
      const verified = unchanged && transition !== "unchanged-at-deadline";
      expect(result.ok).toBe(verified);
      if (transition === "unchanged-at-deadline") {
        expect(result.stopReason).toBe("gateway-readiness-pending");
        expect(updateResult.steps[0]?.exitCode).toBe(0);
      }
      if (transition === "replacement-at-deadline") {
        expect(result).toMatchObject({ ok: false, summary: "generation-changed" });
        expect(result.stopReason).toBeUndefined();
        expect(updateResult.steps[0]?.exitCode).toBe(1);
      }
      if (transition === "readyz-error") {
        expect(result).toMatchObject({ ok: false, summary: "readyz-unhealthy" });
        expect(result.stopReason).toBeUndefined();
        expect(updateResult.steps).toContainEqual(
          expect.objectContaining({ name: "gateway verification", exitCode: 1 }),
        );
      }
      if (verified) {
        expect(onVerified).toHaveBeenCalledOnce();
        expect(recordUpdateRunVerification).toHaveBeenLastCalledWith(
          "synthetic-update",
          expect.objectContaining({
            ...(pidless ? {} : { pid: 8000 }),
            settled: true,
            readyz: true,
          }),
          expect.anything(),
        );
      } else {
        expect(onVerified).not.toHaveBeenCalled();
        expect(recordUpdateRunVerification).not.toHaveBeenCalledWith(
          "synthetic-update",
          expect.objectContaining({ settled: true, readyz: true }),
          expect.anything(),
        );
      }
    },
  );
});
