import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import {
  createGatewayRestartDeadline,
  GatewayRestartDeadlineError,
} from "./restart-health-deadline.js";
import * as restart from "./restart-health.test-helpers.js";

const { resolveGatewayServiceMock } = vi.hoisted(() => ({
  resolveGatewayServiceMock: vi.fn(),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: resolveGatewayServiceMock,
}));

const { inspectGatewayRestart } = await import("./restart-health.js");
const { observeUpdateGatewayReadiness } = await import("../update-cli/update-command-readiness.js");

const deadlines: ReturnType<typeof createGatewayRestartDeadline>[] = [];
const running = { status: "running", pid: 8000 } as const;
let service: ReturnType<typeof restart.makeGatewayService>;
function deadlineAfter(timeoutMs: number, signal?: AbortSignal) {
  const deadline = createGatewayRestartDeadline({ timeoutMs, signal });
  deadlines.push(deadline);
  return deadline;
}
async function expireAfter(ms: number) {
  restart.monotonicClock.nowMs = ms;
  await vi.advanceTimersByTimeAsync(ms);
}
function spendAllowance(ms: number, message: string, allowance = ms) {
  restart.monotonicClock.nowMs += Math.min(ms, allowance);
  if (allowance < ms) {
    throw new Error(message);
  }
}

beforeEach(() => {
  restart.resetRestartHealthMocks();
  service = restart.makeGatewayService(running);
  resolveGatewayServiceMock.mockReset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  restart.inspectPortUsage.mockResolvedValue(restart.portUsage([{ pid: 8000 }]));
  restart.callGateway.mockImplementation(gatewayHealthResponse());
});
afterEach(() => {
  deadlines.splice(0).forEach((deadline) => deadline.dispose());
  vi.useRealTimers();
  restart.restoreRestartHealthMocks();
});

it.each([
  "probe-context",
  "service-command",
  "probe-hosts",
  "service-runtime",
  "port-inspection",
  "startup-health",
  "gateway-health",
  "legacy-owner",
] as const)("bounds a stalled %s read and stops its late continuation", async (phase) => {
  const entered = createDeferred();
  const released = createDeferred();
  const afterStall =
    <T>(value: T) =>
    async () => {
      entered.resolve();
      await released.promise;
      return value;
    };
  const stallAt = {
    "probe-context": () =>
      restart.readBestEffortConfig.mockImplementation(
        afterStall({ gateway: { auth: { mode: "none" } } }),
      ),
    "service-command": () => vi.mocked(service.readCommand).mockImplementation(afterStall(null)),
    "probe-hosts": () =>
      restart.resolveGatewayServiceProbeHosts.mockImplementation(afterStall(["127.0.0.1"])),
    "service-runtime": () => vi.mocked(service.readRuntime).mockImplementation(afterStall(running)),
    "port-inspection": () =>
      restart.inspectPortUsage.mockImplementation(afterStall(restart.portUsage([{ pid: 8000 }]))),
    "startup-health": () => restart.requestStartupProbe.mockImplementation(afterStall(null)),
    "gateway-health": () =>
      restart.callGateway.mockImplementation(async (options) => {
        await afterStall(undefined)();
        return gatewayHealthResponse()(options);
      }),
    "legacy-owner": () => {
      vi.mocked(service.readRuntime).mockResolvedValue({ status: "stopped", missingUnit: true });
      restart.inspectPortUsage.mockResolvedValue(restart.portUsage());
      restart.readActiveGatewayLockIdentity.mockImplementation(afterStall(undefined));
    },
  };
  stallAt[phase]();
  const deadline = deadlineAfter(1_000);
  try {
    const observed = restart
      .waitForRunningGateway({
        service,
        deadline,
        requirePluginHealth: false,
        waitForMissingService: phase === "legacy-owner" ? false : undefined,
      })
      .catch((error: unknown) => error);
    await entered.promise;
    await expireAfter(1_000);
    expect(await observed).toBeInstanceOf(GatewayRestartDeadlineError);
    expect(deadline.expiredPhase).toBe(`health-wait:${phase}`);
    expect(deadline.elapsedMs()).toBe(1_000);
    const readCounts = () =>
      [
        vi.mocked(service.readRuntime),
        restart.resolveGatewayProbeAuthSafeWithSecretInputs,
        restart.resolveGatewayServiceProbeHosts,
        restart.inspectPortUsage,
        restart.requestStartupProbe,
        restart.callGateway,
        restart.readActiveGatewayLockIdentity,
        restart.readGatewayOwnerLease,
      ].map((read) => read.mock.calls.length);
    const atExpiry = readCounts();
    released.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(readCounts()).toEqual(atExpiry);
  } finally {
    released.resolve();
  }
});

it("spends the remaining allowance on reconciliation after managed readiness", async () => {
  const deadline = deadlineAfter(2_000);
  const settled = await restart.waitForRunningGateway({
    service,
    deadline,
    requirePluginHealth: false,
  });
  expect(settled).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: 0 });
  const entered = createDeferred();
  restart.inspectPortUsage.mockImplementation(() => {
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
  await expireAfter(2_000);
  expect(await observed).toMatchObject({
    name: "GatewayRestartDeadlineError",
    phase: "reconciliation:inspect:port-inspection",
  });
  expect(deadline.elapsedMs()).toBe(2_000);
});

it.each(["restart", "update-recovery", "update-verification"] as const)(
  "keeps native inspection independent of the RPC cap at %s",
  async (boundary) => {
    service = {
      ...service,
      isLoaded: vi.fn(async () => true),
    };
    resolveGatewayServiceMock.mockReturnValue(service);
    vi.mocked(service.readRuntime).mockImplementation(async (_env, options) => {
      spendAllowance(6_000, "native service inspection timed out", options?.timeoutMs);
      return running;
    });
    restart.callGateway.mockImplementation(async (options) => {
      spendAllowance(1_000, "Gateway health probe timed out", options.timeoutMs);
      return gatewayHealthResponse()(options);
    });
    restart.requestReadinessProbe.mockResolvedValue({ statusCode: 200, body: "" });

    const deadline = deadlineAfter(30_000);
    let health: Awaited<ReturnType<typeof inspectGatewayRestart>>;
    if (boundary === "restart") {
      health = await restart.waitForRunningGateway({
        service,
        deadline,
        deadlineOutcome: "snapshot",
        probeTimeoutMs: 5_000,
        requireRunningService: true,
        requirePluginHealth: false,
      });
    } else {
      const observed = await observeUpdateGatewayReadiness({
        serviceEnv: {},
        gatewayPort: 18789,
        timeoutMs: 30_000,
        deadlineMs: deadline.deadlineMs,
        probeTimeoutMs: 5_000,
        waitForStartup: boundary === "update-verification",
        requireRunningService: true,
      });
      expect(observed.readyz).toBe(true);
      health = observed.health;
    }
    expect(health).toMatchObject({ healthy: true, runtime: running });
    expect(restart.monotonicClock.nowMs).toBeGreaterThan(6_000);
    expect(restart.monotonicClock.nowMs).toBeLessThan(30_000);
    expect(restart.callGateway.mock.calls.length).toBeGreaterThan(0);
    for (const [request] of restart.callGateway.mock.calls) {
      expect(request.timeoutMs).toBeLessThanOrEqual(5_000);
    }
  },
);

it.each(["native runtime", "legacy owner"])(
  "honors caller cancellation while %s is pending",
  async (phase) => {
    const caller = new AbortController();
    const deadline = deadlineAfter(1_000, caller.signal);
    const entered = createDeferred();
    const pendingRead = () => {
      entered.resolve();
      return createDeferred<never>().promise;
    };
    if (phase === "native runtime") {
      vi.mocked(service.readRuntime).mockImplementation(pendingRead);
    } else {
      vi.mocked(service.readRuntime).mockResolvedValue({ status: "stopped", missingUnit: true });
      restart.inspectPortUsage.mockResolvedValue(restart.portUsage());
      restart.readActiveGatewayLockIdentity.mockImplementation(pendingRead);
    }
    const observed = (
      phase === "native runtime"
        ? inspectGatewayRestart({ service, port: 18789, deadline })
        : restart.waitForRunningGateway({
            service,
            deadline,
            waitForMissingService: false,
          })
    ).catch((error: unknown) => error);
    await entered.promise;
    const reason = new Error("operator canceled observation");
    caller.abort(reason);
    expect(await observed).toBe(reason);
    expect(deadline.expiredPhase).toBeUndefined();
    expect(restart.inspectPortUsage).toHaveBeenCalledTimes(phase === "native runtime" ? 0 : 1);
  },
);
