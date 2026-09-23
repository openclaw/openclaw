import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  monotonicClock,
  readBestEffortConfig,
  readGatewayOwnerLease,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
} from "./restart-health.test-helpers.js";

let waitForGatewayHealthyRestart: typeof import("./restart-health.js").waitForGatewayHealthyRestart;

describe("restart health supervision", () => {
  beforeEach(async () => {
    resetRestartHealthMocks();
    mockProcessPlatform("darwin");
    ({ waitForGatewayHealthyRestart } = await import("./restart-health.js"));
  });
  afterEach(restoreRestartHealthMocks);

  it("infers a loaded supervisor once and settles its late replacement generation", async () => {
    const env = { OPENCLAW_PROFILE: "work" };
    const service = makeGatewayService({ status: "running", pid: 4200 });
    vi.mocked(service.isLoaded).mockResolvedValue(true);
    vi.mocked(service.readRuntime).mockImplementation(async () =>
      monotonicClock.nowMs < 4000
        ? { status: "running", pid: 4200 }
        : monotonicClock.nowMs < 14_000
          ? { status: "stopped" }
          : { status: "running", pid: 4300 },
    );
    inspectPortUsage.mockImplementation(async () => ({
      port: 18789,
      status: monotonicClock.nowMs < 14_000 ? "free" : "busy",
      listeners: monotonicClock.nowMs < 14_000 ? [] : [{ pid: 4300 }],
      hints: [],
    }));
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.9.4", buildId: "replacement-build", bootId: "replacement-boot" },
      }),
    );

    const snapshot = await waitForGatewayHealthyRestart({
      service,
      env,
      port: 18789,
      expectedVersion: "2026.9.4",
      expectedBuildId: "replacement-build",
      requireRunningService: true,
      settle: { probes: 12 },
    });
    expect(snapshot).toMatchObject({
      healthy: true,
      waitOutcome: "healthy",
      elapsedMs: 19_500,
      runtime: { status: "running", pid: 4300 },
      gatewayBootId: "replacement-boot",
    });
    expect(service.isLoaded).toHaveBeenCalledExactlyOnceWith({ env, timeoutMs: 5000 });
    expect(service.readRuntime).toHaveBeenCalledTimes(40);
  });

  it.each(["unloaded", "unavailable"] as const)(
    "retains stopped-free failure when supervision is %s",
    async (state) => {
      const service = makeGatewayService({ status: "stopped" });
      if (state === "unavailable") {
        vi.mocked(service.isLoaded).mockRejectedValue(new Error("launchctl unavailable"));
      }
      const snapshot = await waitForGatewayHealthyRestart({ service, port: 18789 });
      expect(snapshot).toMatchObject({
        healthy: false,
        waitOutcome: "stopped-free",
        elapsedMs: 12_500,
      });
      expect(service.isLoaded).toHaveBeenCalledExactlyOnceWith({
        env: undefined,
        timeoutMs: 5000,
      });
    },
  );

  it.each([
    { platform: "darwin", supervisorKeepsAlive: true, elapsedMs: 60_000 },
    { platform: "darwin", supervisorKeepsAlive: false, elapsedMs: 12_500 },
    { platform: "linux", supervisorKeepsAlive: undefined, elapsedMs: 12_500 },
    { platform: "win32", supervisorKeepsAlive: undefined, elapsedMs: 32_500 },
  ] as const)(
    "preserves $platform explicit supervision=$supervisorKeepsAlive",
    async ({ platform, supervisorKeepsAlive, elapsedMs }) => {
      mockProcessPlatform(platform);
      const service = makeGatewayService({ status: "stopped" });
      vi.mocked(service.isLoaded).mockRejectedValue(new Error("unexpected supervisor query"));
      const snapshot = await waitForGatewayHealthyRestart({
        service,
        port: 18789,
        supervisorKeepsAlive,
      });
      expect(snapshot.elapsedMs).toBe(elapsedMs);
      expect(service.isLoaded).not.toHaveBeenCalled();
    },
  );

  it("does not infer launchd supervision for a directly spawned child", async () => {
    const snapshot = await waitForGatewayHealthyRestart({
      child: { pid: 4200, exitCode: 1, signalCode: null },
      port: 18789,
    });
    expect(snapshot).toMatchObject({
      healthy: false,
      waitOutcome: "stopped-free",
      elapsedMs: 12_500,
    });
  });

  it.each([
    { timeoutMs: 10_000, preparationMs: 0, expectedTimeout: 5000 },
    { timeoutMs: 2000, preparationMs: 0, expectedTimeout: 2000 },
    { timeoutMs: 2000, preparationMs: 750, expectedTimeout: 1250 },
    { timeoutMs: 2000, preparationMs: 2000, expectedTimeout: undefined },
    { timeoutMs: 2000, preparationMs: 2500, expectedTimeout: undefined },
  ])(
    "bounds native inspection by the remaining $timeoutMs ms budget after $preparationMs ms",
    async ({ timeoutMs, preparationMs, expectedTimeout }) => {
      const env = { OPENCLAW_PROFILE: "bounded" };
      const service = makeGatewayService({ status: "stopped" });
      readBestEffortConfig.mockImplementation(async () => {
        monotonicClock.nowMs += preparationMs;
        return {};
      });
      vi.mocked(service.isLoaded).mockImplementation(async (args) => {
        expect(args.timeoutMs).toBe(expectedTimeout);
        monotonicClock.nowMs += args.timeoutMs ?? 0;
        return false;
      });
      const snapshot = await waitForGatewayHealthyRestart({
        service,
        env,
        port: 18789,
        timeoutMs,
      });
      expect(snapshot).toMatchObject({
        healthy: false,
        waitOutcome: "timeout",
        elapsedMs: Math.max(timeoutMs, preparationMs),
      });
      if (expectedTimeout === undefined) {
        expect(service.isLoaded).not.toHaveBeenCalled();
      } else {
        expect(service.isLoaded).toHaveBeenCalledExactlyOnceWith({
          env,
          timeoutMs: expectedTimeout,
        });
      }
    },
  );

  it.each(["loaded", "unloaded", "unavailable"] as const)(
    "does not start health probes after %s supervision exhausts the absolute deadline",
    async (state) => {
      const service = makeGatewayService({ status: "stopped" });
      monotonicClock.nowMs = 1000;
      vi.mocked(service.isLoaded).mockImplementation(async (args) => {
        monotonicClock.nowMs += args.timeoutMs ?? 0;
        if (state === "unavailable") {
          throw new Error("launchctl unavailable");
        }
        return state === "loaded";
      });
      vi.mocked(service.readRuntime).mockImplementation(async () => {
        monotonicClock.nowMs += 5000;
        return { status: "stopped" };
      });

      const snapshot = await waitForGatewayHealthyRestart({
        service,
        port: 18789,
        timeoutMs: 10_000,
        deadlineMs: 3000,
      });
      expect(service.isLoaded).toHaveBeenCalledExactlyOnceWith({
        env: undefined,
        timeoutMs: 2000,
      });
      expect(snapshot).toMatchObject({ healthy: false, waitOutcome: "timeout", elapsedMs: 2000 });
      expect(service.readRuntime).not.toHaveBeenCalled();
      expect(inspectPortUsage).not.toHaveBeenCalled();
      expect(callGateway).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 0])(
    "keeps zero-retry inspection distinct from an explicit %s ms time budget",
    async (timeoutMs) => {
      const service = makeGatewayService({ status: "stopped" });
      const snapshot = await waitForGatewayHealthyRestart({
        service,
        port: 18789,
        attempts: 0,
        delayMs: 1,
        timeoutMs,
      });
      expect(snapshot).toMatchObject({ healthy: false, waitOutcome: "timeout", elapsedMs: 0 });
      expect(service.isLoaded).not.toHaveBeenCalled();
      expect(service.readRuntime).toHaveBeenCalledTimes(timeoutMs === undefined ? 1 : 0);
      expect(inspectPortUsage).toHaveBeenCalledTimes(timeoutMs === undefined ? 1 : 0);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("preserves stopped-free failure for a runtime-only diagnostic adapter", async () => {
    const nativeService = makeGatewayService({ status: "stopped" });
    vi.mocked(nativeService.isLoaded).mockResolvedValue(true);
    const service = {
      readCommand: nativeService.readCommand,
      readRuntime: nativeService.readRuntime,
    };
    const snapshot = await waitForGatewayHealthyRestart({ service, port: 18789 });
    expect(snapshot).toMatchObject({
      healthy: false,
      waitOutcome: "stopped-free",
      elapsedMs: 12_500,
    });
    expect(nativeService.isLoaded).not.toHaveBeenCalled();
  });

  it.each(["preparation", "supervisor"] as const)(
    "preserves abort identity after %s without starting health probes",
    async (stage) => {
      const service = makeGatewayService({ status: "stopped" });
      const controller = new AbortController();
      const reason = new Error("original restart cancellation");
      if (stage === "preparation") {
        readBestEffortConfig.mockImplementation(async () => {
          controller.abort(reason);
          return {};
        });
      } else {
        vi.mocked(service.isLoaded).mockImplementation(async () => {
          controller.abort(reason);
          throw new Error("native inspection also failed");
        });
      }
      await expect(
        waitForGatewayHealthyRestart({ service, port: 18789, signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(service.isLoaded).toHaveBeenCalledTimes(stage === "supervisor" ? 1 : 0);
      expect(service.readRuntime).not.toHaveBeenCalled();
      expect(inspectPortUsage).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it.each(["cooperative", "uncertain"] as const)(
    "joins signal-only supervision cancellation with %s command cleanup",
    async (cleanupResult) => {
      const service = makeGatewayService({ status: "stopped" });
      const caller = new AbortController();
      const reason = new Error("operator canceled supervision");
      const entered = createDeferred();
      const canceled = createDeferred();
      const cleanup = createDeferred<"cooperative" | "uncertain">();
      let nativeSignal: AbortSignal | undefined;
      let releaseProbe: (() => void) | undefined;
      let observationSettled = false;
      vi.mocked(service.isLoaded).mockImplementation(async () => {
        nativeSignal = resolveCommandProcessSignal();
        retainCommandProcessCleanup(cleanup.promise);
        const pending = new Promise<void>((resolve) => {
          releaseProbe = resolve;
          nativeSignal?.addEventListener(
            "abort",
            () => {
              canceled.resolve();
              resolve();
            },
            { once: true },
          );
        });
        entered.resolve();
        await pending;
        return false;
      });
      const observed = waitForGatewayHealthyRestart({
        service,
        port: 18789,
        signal: caller.signal,
      })
        .catch((error: unknown) => error)
        .finally(() => {
          observationSettled = true;
        });
      try {
        await entered.promise;
        expect(nativeSignal).toBeDefined();
        expect(nativeSignal?.aborted).toBe(false);
        caller.abort(reason);
        await canceled.promise;
        expect(nativeSignal?.aborted).toBe(true);
        expect(observationSettled).toBe(false);
        cleanup.resolve(cleanupResult);
        if (cleanupResult === "uncertain") {
          expect(await observed).toBeInstanceOf(CommandProcessCleanupError);
        } else {
          expect(await observed).toBe(reason);
        }
        expect(service.readRuntime).not.toHaveBeenCalled();
        expect(inspectPortUsage).not.toHaveBeenCalled();
        expect(callGateway).not.toHaveBeenCalled();
        expect(sleep).not.toHaveBeenCalled();
      } finally {
        caller.abort(reason);
        releaseProbe?.();
        cleanup.resolve(cleanupResult);
        await observed;
      }
    },
  );

  it.each([
    { wrapped: false, aborted: false },
    { wrapped: true, aborted: false },
    { wrapped: false, aborted: true },
    { wrapped: true, aborted: true },
  ])(
    "rejects uncertain native cleanup (wrapped=$wrapped, aborted=$aborted) before health probes",
    async ({ wrapped, aborted }) => {
      const service = makeGatewayService({ status: "stopped" });
      const cleanupError = new CommandProcessCleanupError();
      const failure = wrapped
        ? new Error("inspection failed", { cause: cleanupError })
        : cleanupError;
      const controller = new AbortController();
      const abortReason = new Error("original restart cancellation");
      vi.mocked(service.isLoaded).mockImplementation(async () => {
        if (aborted) {
          controller.abort(abortReason);
        }
        throw failure;
      });
      await expect(
        waitForGatewayHealthyRestart({ service, port: 18789, signal: controller.signal }),
      ).rejects.toBe(failure);
      expect(service.isLoaded).toHaveBeenCalledOnce();
      expect(service.readRuntime).not.toHaveBeenCalled();
      expect(inspectPortUsage).not.toHaveBeenCalled();
      expect(callGateway).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("does not start a native probe with less than one millisecond remaining", async () => {
    const service = makeGatewayService({ status: "stopped" });
    readBestEffortConfig.mockImplementation(async () => {
      monotonicClock.nowMs = 1999.5;
      return {};
    });
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      timeoutMs: 2000,
    });
    expect(snapshot).toMatchObject({ healthy: false, waitOutcome: "timeout" });
    expect(service.isLoaded).not.toHaveBeenCalled();
  });

  it.each(["live", "unknown"] as const)(
    "keeps positive owner death authoritative after observing %s with loaded supervision",
    async (initialState) => {
      const service = makeGatewayService({ status: "stopped" });
      vi.mocked(service.isLoaded).mockResolvedValue(true);
      readGatewayOwnerLease.mockImplementation(() => ({
        owner: "current-gateway-owner",
        pid: 4300,
        host: "gateway-test-host",
        startedAt: 1000,
        port: 18789,
        mode: "supervised",
        supervisor: { kind: "launchd", name: "ai.openclaw.gateway" },
        state: monotonicClock.nowMs === 0 ? initialState : "dead",
        expired: false,
      }));
      const snapshot = await waitForGatewayHealthyRestart({ service, port: 18789 });
      expect(snapshot).toMatchObject({
        healthy: false,
        waitOutcome: "stopped-free",
        elapsedMs: 500,
      });
      expect(service.isLoaded).toHaveBeenCalledOnce();
      expect(sleep).toHaveBeenCalledOnce();
    },
  );
});
