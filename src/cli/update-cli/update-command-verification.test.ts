import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveGatewayStartupTiming } from "../../commands/gateway-startup-timing.js";
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
import { isUpdateRunVerificationConfirmed } from "../../infra/update-run-verification.js";
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
  sleep,
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
async function listen(handler: RequestListener = (_req, res) => res.writeHead(200).end()) {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing loopback listener");
  }
  return address.port;
}

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

describe("update readiness", () => {
  it.each(
    (["npm", "pnpm", "bun"] as const).flatMap((mode) =>
      (
        [
          "ready",
          "starting",
          "old-version",
          "old-build",
          "missing-build",
          "retained-identity",
        ] as const
      ).map((state) => ({ mode, state })),
    ),
  )(
    "observes a package watcher restart without failing --no-restart ($mode, $state)",
    async ({ mode, state }) => {
      const verified = state === "ready" || state === "retained-identity";
      mockProcessPlatform("linux");
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(
        makeGatewayService({ status: "running", pid: 8000 }),
      );
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      }));
      callGateway.mockImplementation(
        state === "starting"
          ? async () => {
              throw new Error("gateway timeout after 3000ms");
            }
          : gatewayHealthResponse({
              server: {
                version:
                  state === "old-version" || state === "retained-identity"
                    ? "2026.9.7"
                    : "2026.9.8",
                buildId:
                  state === "missing-build"
                    ? undefined
                    : state === "old-build"
                      ? "previous-build"
                      : state === "retained-identity"
                        ? "retained-build"
                        : "candidate",
                bootId: "watcher-successor",
              },
            }),
      );
      const result: UpdateRunResult = {
        status: "ok",
        mode,
        after: { version: "2026.9.8", buildId: "candidate" },
        steps: [],
        durationMs: 0,
      };
      const outcome = await maybeRestartService({
        result,
        opts: { json: true, restart: false, run: { runId: "watcher-restart", env: {} } },
        shouldRestart: false,
        observePackageReplacement: true,
        expectedGatewayIdentity:
          state === "retained-identity"
            ? { version: "2026.9.7", buildId: "retained-build" }
            : undefined,
        refreshServiceEnv: false,
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort: await listen(),
        timeoutMs: 1000,
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
        expect(
          renderUpdateRunReport({
            ...updateRunReportInputFromResult(result),
            verification: facts ?? {},
          }).markdown,
        ).toContain("build mismatch");
      }
    },
  );

  it.each(["transient-timeout", "mixed"])(
    "records collection and channel probe warnings after core verification (%s)",
    async (kind) => {
      mockProcessPlatform("linux");
      const service = makeGatewayService({ status: "running", pid: 8000 });
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      }));
      let probes = 0;
      callGateway.mockImplementation((opts) =>
        gatewayHealthResponse({
          server: { version: "2026.9.8", buildId: "candidate", bootId: "candidate-boot" },
          health: {
            channels: {
              telegram: {
                probe:
                  kind === "transient-timeout" && probes++ > 0
                    ? { ok: true }
                    : {
                        ...(kind === "timeout" ? {} : { ok: false }),
                        ...(kind === "negative" ? {} : { timedOut: true }),
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
      const result: UpdateRunResult = { status: "ok", mode: "npm", steps: [], durationMs: 0 };
      const onVerified = vi.fn();
      const verification = await verifyUpdatedGateway({
        result,
        opts: { json: true, run: { runId: "collection-timeout", env: {} } },
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort: await listen(),
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
          channelsReady: true,
        }),
        expect.anything(),
      );
      const facts = vi.mocked(recordUpdateRunVerification).mock.calls.at(-1)?.[1];
      expect(facts && isUpdateRunVerificationConfirmed(facts)).toBe(true);
      if (kind !== "negative") {
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
      }
    },
  );

  it.each<{
    readyzStatus: number;
    slowInspection?: "command" | "runtime" | "listener";
  }>([{ readyzStatus: 200, slowInspection: "command" }])(
    "observes foreground identity and HTTP once (HTTP $readyzStatus, slow=$slowInspection)",
    async ({ readyzStatus, slowInspection }) => {
      const service = makeGatewayService({ status: "stopped" });
      const inspect = (phase: typeof slowInspection) => {
        if (slowInspection === phase) {
          monotonicClock.nowMs += 3_300;
        }
      };
      vi.mocked(service.readCommand).mockImplementation(async () => {
        inspect("command");
        return null;
      });
      vi.mocked(service.readRuntime).mockImplementation(async () => {
        inspect("runtime");
        return { status: "unknown" };
      });
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => {
        inspect("listener");
        return { port, status: "busy", listeners: [{ pid: 8000 }], hints: [] };
      });
      callGateway.mockImplementation((opts) => {
        const responseMs = 5;
        if ((opts.timeoutMs ?? responseMs) < responseMs) {
          throw new Error("Gateway health response exceeded its remaining allowance");
        }
        return gatewayHealthResponse({
          server: { version: "2026.9.5", buildId: "installed-build", bootId: "foreground-boot" },
        })(opts);
      });
      const requests: string[] = [];
      const gatewayPort = await listen((req, res) => {
        requests.push(req.url ?? "");
        res.writeHead(req.url === "/readyz" ? readyzStatus : 200).end();
      });
      const result: UpdateRunResult = {
        status: "error",
        mode: "npm",
        reason: "doctor-failed",
        steps: [],
        durationMs: 0,
      };
      const verification = verifyUpdatedGateway({
        result,
        opts: { json: true },
        purpose: "recovery",
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort,
        expectedVersion: "2026.9.5",
        expectedBuildId: "installed-build",
        waitForStartup: false,
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      pendingVerification = verification;
      expect(await verification).toMatchObject({ ok: readyzStatus === 200 });
      expect(requests.toSorted()).toEqual(["/healthz", "/readyz"]);
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
      expect(monotonicClock.nowMs).toBe(slowInspection ? 6_600 : 0);
      for (const [params] of callGateway.mock.calls) {
        expect(params.timeoutMs).toBe(3_000);
      }
      expect(result).toMatchObject({ status: "error", reason: "doctor-failed" });
      expect(result.verification?.serviceRunning).toBeUndefined();
      expect(result.verification?.readyz).toBe(readyzStatus === 200);
      expect(result.steps[0]?.exitCode).toBe(readyzStatus === 200 ? 0 : 1);
      expect(result.steps[0]?.termination).toBeUndefined();
      if (readyzStatus !== 200) {
        expect(result.steps[0]?.failureFacts).toContainEqual(
          expect.objectContaining({ code: "readyz-unhealthy" }),
        );
      }
    },
  );

  it.each([30 * 60_000])(
    "bounds foreground verification when HTTP readiness cannot complete (%ims)",
    async (timeoutMs) => {
      const service = makeGatewayService({ status: "stopped" });
      vi.mocked(service.readRuntime).mockResolvedValue({ status: "unknown" });
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000 }],
        hints: [],
      }));
      callGateway.mockImplementation(
        gatewayHealthResponse({ server: { version: "2026.9.5", bootId: "foreground-boot" } }),
      );
      const gatewayPort = await listen((req, res) => {
        if (req.url === "/healthz") {
          res.writeHead(200).end();
        }
        // Leave readiness requests unanswered if they reach the listener.
      });
      const result: UpdateRunResult = { status: "error", mode: "npm", steps: [], durationMs: 0 };
      const startedAt = Date.now();
      const verification = verifyUpdatedGateway({
        result,
        opts: { json: true },
        purpose: "recovery",
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort,
        expectedVersion: "2026.9.5",
        waitForStartup: false,
        timeoutMs,
        signal: controller.signal,
      });
      pendingVerification = verification;
      await expect(verification).resolves.toMatchObject({ ok: false, summary: "readyz-unhealthy" });
      expect(Date.now() - startedAt).toBeLessThan(timeoutMs === 100 ? 1_000 : 5_000);
      expect(result.verification).toMatchObject({ readyz: false, settled: false });
      expect(result.steps[0]).toMatchObject({
        exitCode: 1,
        failureFacts: expect.arrayContaining([
          expect.objectContaining({ check: "readyz", code: "readyz-unhealthy" }),
        ]),
      });
      expect(sleep).not.toHaveBeenCalled();
      expect(result.steps[0]?.termination).toBeUndefined();
      expect(result.steps[0]?.advisory).toBeUndefined();
      for (const [params] of callGateway.mock.calls) {
        expect(params.timeoutMs).toBeLessThanOrEqual(timeoutMs === 100 ? 100 : 3_000);
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
      const service = makeGatewayService({ status: "running", pid: 8000 });
      let readRuntime = false;
      vi.mocked(service.readRuntime).mockImplementation(() => {
        if (phase === "after listener observation" && !readRuntime) {
          readRuntime = true;
          return Promise.resolve({ status: "running", pid: 8000 });
        }
        entered.resolve();
        return released.promise;
      });
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      const result: UpdateRunResult = { status: "ok", mode: "npm", steps: [], durationMs: 0 };
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
      let outcome: unknown;
      let settled = false;
      pendingVerification = verifyUpdatedGateway({
        result,
        opts: { json: true, run: { runId: "stalled-readiness", env: {} } },
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort: 18789,
        expectedVersion: "2026.9.4",
        requireRunningService: true,
        timeoutMs: 1_000,
        signal: controller.signal,
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
      }).then(
        (value) => {
          outcome = value;
          settled = true;
        },
        (error: unknown) => {
          outcome = error;
          settled = true;
        },
      );
      try {
        await entered.promise;
        monotonicClock.nowMs = 1_000;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(settled).toBe(true);
        expect(outcome).toMatchObject({ ok: false });
        expect(result.steps).toContainEqual(
          expect.objectContaining({ name: "gateway verification", exitCode: 1 }),
        );
        expect(onVerified).not.toHaveBeenCalled();
        released.resolve({ status: "running", pid: 8000 });
        await vi.advanceTimersByTimeAsync(0);
        expect(onVerified).not.toHaveBeenCalled();
        expect(lateMutation).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        released.resolve({ status: "running", pid: 8000 });
        await pendingVerification;
        vi.useRealTimers();
      }
    },
  );

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

  it.each(["runtime", "port", "command"] as const)(
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
      const gatewayPort = await listen();
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
        gatewayPort,
        expectedVersion: "2026.9.5",
        expectedBuildId: "candidate-build",
        signal: controller.signal,
      });
      pendingVerification = verification;
      await expect(verification).rejects.toBe(cleanup);
      expect(result.verification).toBeUndefined();
      expect(result.steps).toEqual([]);
    },
  );

  it.each([
    {
      startupAtMs: 1_500,
      healthyAtMs: 1_500,
      timeoutMs: 1_000,
      verified: false,
      minMs: 1_000,
      maxMs: 1_500,
    },
    {
      startupAtMs: 12_500,
      healthyAtMs: 20_000,
      timeoutMs: undefined,
      verified: true,
      minMs: 20_000,
      maxMs: 21_500,
    },
  ])(
    "keeps readiness within the startup allowance (startup=$startupAtMs)",
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
      const gatewayPort = await listen((_req, res) => {
        httpRequests++;
        res.writeHead(200).end();
      });
      const verification = verifyUpdatedGateway({
        result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
        opts: { json: true },
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort,
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
      const gatewayPort = await listen();
      const result = await maybeRestartService({
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
        gatewayPort,
        requireRunningServiceAfterRestart: true,
        timeoutMs: exhausted ? 60_000 : 120_000,
      });
      const pending = exhausted && !childTimeout;
      expect(result, JSON.stringify(vi.mocked(defaultRuntime.error).mock.calls)).toBe(
        pending ? "readiness-pending" : "ok",
      );
      expect(monotonicClock.nowMs).toBe(pending ? 60_000 : 90_000);
      expect(callGateway).toHaveBeenCalledTimes(pending ? 0 : 2);
      expect(runUpdatedInstallGatewayCommand).toHaveBeenCalledOnce();
    },
  );

  it.each([{ timeout: undefined, readyAtMs: 44 * 60_000, expected: "ok" }])(
    "preserves Windows cold startup and an explicit update timeout ($timeout, ready at $readyAtMs)",
    async ({ timeout, readyAtMs, expected }) => {
      const budgetMs =
        timeout === undefined
          ? resolveGatewayStartupTiming("win32").deadlineMs
          : Number(timeout) * 1_000;
      mockProcessPlatform("win32");
      const service = makeGatewayService({ status: "running", pid: 8000 });
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: monotonicClock.nowMs < readyAtMs ? "free" : "busy",
        listeners: monotonicClock.nowMs < readyAtMs ? [] : [{ pid: 8000 }],
        hints: [],
      }));
      sleep.mockImplementation(async (delayMs) => {
        // Advance the cold-loading interval without thousands of identical probes.
        monotonicClock.nowMs +=
          monotonicClock.nowMs === 0 ? Math.min(readyAtMs, budgetMs) : delayMs;
      });
      callGateway.mockImplementation(
        gatewayHealthResponse({ server: { version: "2026.9.4", bootId: "windows-cold-boot" } }),
      );
      const gatewayPort = await listen();
      const outcome = await maybeRestartService({
        shouldRestart: true,
        result: {
          status: "ok",
          mode: "npm",
          steps: [],
          durationMs: 0,
          after: { version: "2026.9.4" },
        },
        opts: { json: true, timeout },
        refreshServiceEnv: false,
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort,
        requireRunningServiceAfterRestart: true,
        timeoutMs: timeout === undefined ? 30 * 60_000 : 60_000,
      });

      expect(outcome).toBe(expected);
      expect(runUpdatedInstallGatewayCommand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ timeoutMs: budgetMs }),
        "restart",
      );
      expect(monotonicClock.nowMs).toBe(Math.min(readyAtMs, budgetMs));
    },
  );

  it.each([
    { transition: "unchanged", supplied: false },
    { transition: "unchanged", supplied: true },
    { transition: "readiness-at-deadline", supplied: false },
    { transition: "first-final-health-error", supplied: false },
    { transition: "readyz-error", supplied: false },
  ] as const)(
    "checks final native and HTTP readiness: $transition, supplied=$supplied",
    async ({ transition, supplied }) => {
      // Keep the real health/hello interpretation and HTTP readiness loop.
      // Only the service manager/health RPC are synthetic; HTTP uses a local socket.
      mockProcessPlatform("linux");
      const service = makeGatewayService({ status: "running", pid: 8000 });
      service.isLoaded = vi.fn(async () => true);
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      }));
      callGateway.mockImplementation((opts) =>
        gatewayHealthResponse({
          server: { version: "2026.9.1", buildId: "candidate-build", bootId: "boot-a" },
          ...(transition === "first-final-health-error" && callGateway.mock.calls.length === 2
            ? { error: new Error("synthetic health failed") }
            : {}),
        })(opts),
      );
      const reached = createDeferred();
      const release = createDeferred();
      const gatewayPort = await listen((req, res) => {
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
        env: { HOME: "/synthetic-home" },
        expectedVersion: "2026.9.1",
        expectedBuildId: "candidate-build",
        requireRunningService: true,
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
        gatewayPort,
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
      expect(callGateway).toHaveBeenCalledOnce();
      if (transition.endsWith("at-deadline")) {
        monotonicClock.nowMs = 300_000;
      }
      release.resolve();
      const result = await verification;
      const verified = transition === "unchanged";
      expect(result.ok).toBe(verified);
      if (transition.endsWith("-at-deadline")) {
        // The held HTTP read exhausted the budget; identity cannot be reread afterward.
        expect(result).toMatchObject({ ok: false, summary: "timeout" });
        expect(result.stopReason).toBeUndefined();
        expect(updateResult.steps[0]?.exitCode).toBe(1);
        expect(updateResult.steps[0]?.failureFacts).toContainEqual(
          expect.objectContaining({ code: "timeout" }),
        );
        expect(callGateway).toHaveBeenCalledOnce();
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
            pid: 8000,
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
