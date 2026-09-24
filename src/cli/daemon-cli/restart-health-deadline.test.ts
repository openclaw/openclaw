import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import {
  createGatewayRestartDeadline,
  GatewayRestartDeadlineError,
} from "./restart-health-deadline.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  monotonicClock,
  readBestEffortConfig,
  requestStartupProbe,
  resetRestartHealthMocks,
  resolveGatewayProbeAuthSafeWithSecretInputs,
  resolveGatewayServiceProbeHosts,
  restoreRestartHealthMocks,
} from "./restart-health.test-helpers.js";

const { inspectGatewayRestart, waitForGatewayHealthyRestart } = await import("./restart-health.js");

describe("shared restart observation deadline", () => {
  beforeEach(() => {
    resetRestartHealthMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000 }],
      hints: [],
    });
    callGateway.mockImplementation(gatewayHealthResponse());
  });
  afterEach(() => {
    vi.useRealTimers();
    restoreRestartHealthMocks();
  });

  it.each([
    "probe-context",
    "service-command",
    "probe-hosts",
    "service-runtime",
    "port-inspection",
    "startup-health",
    "gateway-health",
  ])("bounds a stalled %s read and stops its late continuation", async (phase) => {
    const entered = createDeferred();
    const released = createDeferred();
    const stall = async () => {
      entered.resolve();
      await released.promise;
    };
    const service = makeGatewayService({ status: "running", pid: 8000 });
    switch (phase) {
      case "probe-context":
        readBestEffortConfig.mockImplementation(async () => {
          await stall();
          return { gateway: { auth: { mode: "none" } } };
        });
        break;
      case "service-command":
        vi.mocked(service.readCommand).mockImplementation(async () => {
          await stall();
          return null;
        });
        break;
      case "probe-hosts":
        resolveGatewayServiceProbeHosts.mockImplementation(async () => {
          await stall();
          return ["127.0.0.1"];
        });
        break;
      case "service-runtime":
        vi.mocked(service.readRuntime).mockImplementation(async () => {
          await stall();
          return { status: "running", pid: 8000 };
        });
        break;
      case "port-inspection":
        inspectPortUsage.mockImplementation(async () => {
          await stall();
          return { port: 18789, status: "busy", listeners: [{ pid: 8000 }], hints: [] };
        });
        break;
      case "startup-health":
        requestStartupProbe.mockImplementation(async () => {
          await stall();
          return null;
        });
        break;
      case "gateway-health":
        callGateway.mockImplementation(async (options) => {
          await stall();
          return gatewayHealthResponse()(options);
        });
        break;
    }
    const deadline = createGatewayRestartDeadline({ timeoutMs: 1_000 });
    try {
      const observed = waitForGatewayHealthyRestart({
        service,
        port: 18789,
        deadline,
        requirePluginHealth: false,
        settle: { probes: 3 },
      }).catch((error: unknown) => error);
      await entered.promise;
      monotonicClock.nowMs = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await observed).toBeInstanceOf(GatewayRestartDeadlineError);
      expect(deadline.expiredPhase).toBe(`health-wait:${phase}`);
      expect(deadline.elapsedMs()).toBe(1_000);
      const readCounts = () => [
        vi.mocked(service.readRuntime).mock.calls.length,
        resolveGatewayProbeAuthSafeWithSecretInputs.mock.calls.length,
        resolveGatewayServiceProbeHosts.mock.calls.length,
        inspectPortUsage.mock.calls.length,
        requestStartupProbe.mock.calls.length,
        callGateway.mock.calls.length,
      ];
      const atExpiry = readCounts();
      released.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(readCounts()).toEqual(atExpiry);
    } finally {
      released.resolve();
      deadline.dispose();
    }
  });

  it("spends the remaining allowance on reconciliation after managed settlement", async () => {
    const deadline = createGatewayRestartDeadline({ timeoutMs: 2_000 });
    const service = makeGatewayService({ status: "running", pid: 8000 });
    try {
      const settled = await waitForGatewayHealthyRestart({
        service,
        port: 18789,
        deadline,
        requirePluginHealth: false,
        settle: { probes: 3 },
      });
      expect(settled).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: 1_000 });
      const entered = createDeferred();
      inspectPortUsage.mockImplementation(() => {
        entered.resolve();
        return createDeferred<never>().promise;
      });
      const observed = inspectGatewayRestart({
        service,
        port: 18789,
        deadline,
        phase: "reconciliation:inspect",
      }).catch((error: unknown) => error);
      await entered.promise;
      monotonicClock.nowMs = 2_000;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await observed).toMatchObject({
        name: "GatewayRestartDeadlineError",
        phase: "reconciliation:inspect:port-inspection",
      });
      expect(deadline.elapsedMs()).toBe(2_000);
    } finally {
      deadline.dispose();
    }
  });

  it("honors caller cancellation while a native read is pending", async () => {
    const caller = new AbortController();
    const deadline = createGatewayRestartDeadline({ timeoutMs: 1_000, signal: caller.signal });
    const entered = createDeferred();
    const service = makeGatewayService({ status: "running", pid: 8000 });
    vi.mocked(service.readRuntime).mockImplementation(() => {
      entered.resolve();
      return createDeferred<never>().promise;
    });
    try {
      const observed = inspectGatewayRestart({ service, port: 18789, deadline }).catch(
        (error: unknown) => error,
      );
      await entered.promise;
      const reason = new Error("operator canceled observation");
      caller.abort(reason);
      expect(await observed).toBe(reason);
      expect(deadline.expiredPhase).toBeUndefined();
      expect(inspectPortUsage).not.toHaveBeenCalled();
    } finally {
      deadline.dispose();
    }
  });
});
