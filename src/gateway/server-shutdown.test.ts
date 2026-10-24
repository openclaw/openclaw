import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { finishGatewayRestartTrace, startGatewayRestartTrace } from "./restart-trace.js";
import { resolveGatewayShutdownNotice, runGatewayCloseSteps } from "./server-shutdown.js";

const logInfo = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: logInfo }),
}));
const traceMessages = () => logInfo.mock.calls.map(([message]) => String(message));
const hasTrace = (text: string) => traceMessages().some((line) => line.includes(text));
const shutdownFailure = (name: string, cause: Error) => ({
  message: `shutdown step failed (${name}): ${cause.message}`,
  cause,
});

afterEach(() => {
  finishGatewayRestartTrace("test.finish");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  logInfo.mockClear();
});

it("omits invalid restart metadata and normalizes the reason", () => {
  expect(
    resolveGatewayShutdownNotice({ reason: "  upgrade  ", restartExpectedMs: Number.NaN }),
  ).toEqual({
    reason: "upgrade",
  });
  expect(resolveGatewayShutdownNotice({ restartExpectedMs: -2 })).toEqual({
    reason: "gateway stopping",
    restartExpectedMs: 0,
  });
});

type Stop = () => void | Promise<void>;
function createCloseFixture(stop?: Stop, join?: Stop) {
  const owner = {
    connectionWork: { drain: vi.fn(async () => {}) },
    stopConnectionDependentSidecars: vi.fn(),
    stopRegisteredGatewayLifetimeSidecars: vi.fn(stop),
    stopRegisteredPostReadySidecars: vi.fn(),
    runClosePrelude: vi.fn(),
    sealAndJoinRegisteredSidecarStops: vi.fn(join),
  };
  const close = vi.fn(),
    onError = vi.fn();
  return { owner, close, onError, run: () => runGatewayCloseSteps({ owner, close, onError }) };
}

it.each([false, true])("holds shutdown order until settlement (trace=%s)", async (trace) => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  vi.stubEnv("OPENCLAW_GATEWAY_RESTART_TRACE", trace ? "1" : "0");
  startGatewayRestartTrace("stop.signal.received");
  const entered = createDeferredCore();
  const released = createDeferredCore();
  const { owner, onError, run } = createCloseFixture();
  owner.stopRegisteredGatewayLifetimeSidecars.mockImplementation(async () => {
    entered.resolve();
    await released.promise;
  });
  const second = owner.stopRegisteredPostReadySidecars;
  const closing = run();
  try {
    await entered.promise;
    clock.mockReturnValue(1_250);
    expect(second).not.toHaveBeenCalled();
    expect(hasTrace("shutdown.gateway-lifetime-sidecars.begin ")).toBe(trace);
    expect(hasTrace("shutdown.gateway-lifetime-sidecars ")).toBe(false);
    expect(hasTrace("shutdown.post-ready-sidecars")).toBe(false);
  } finally {
    released.resolve();
    await closing;
  }
  expect(second).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(hasTrace("shutdown.gateway-lifetime-sidecars ")).toBe(true);
  expect(hasTrace("shutdown.post-ready-sidecars ")).toBe(trace);
});

it.each([false, true])("retains failures across required joins (failure=%s)", async (joinFails) => {
  const stopError = new Error("optional sidecar stop failed");
  const drainError = new Error("connection cleanup failed");
  const drain = vi.fn(async () => {
    if (joinFails) {
      throw drainError;
    }
  });
  const { run, close, onError } = createCloseFixture(() => {
    throw stopError;
  }, drain);
  await expect(run()).rejects.toMatchObject({
    errors: [
      shutdownFailure("gateway lifetime sidecars", stopError),
      ...(joinFails ? [shutdownFailure("late sidecar cleanup", drainError)] : []),
    ],
  });
  expect(drain).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledTimes(joinFails ? 0 : 1);
  expect(onError).toHaveBeenCalledTimes(joinFails ? 2 : 1);
});

it("names an unavailable module step and continues the remaining shutdown", async () => {
  vi.stubEnv("OPENCLAW_GATEWAY_RESTART_TRACE", "1");
  startGatewayRestartTrace("stop.signal.received");
  const missingModule = Object.assign(new Error("Cannot find module 'rotated-chunk.js'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
  const { run, close, onError } = createCloseFixture(
    vi.fn<() => Promise<void>>().mockRejectedValue(missingModule),
  );
  await expect(run()).rejects.toMatchObject({
    message: "Gateway shutdown did not complete cleanly",
    errors: [expect.objectContaining({ cause: missingModule })],
  });

  expect(close).toHaveBeenCalledOnce();
  expect(onError.mock.calls.flat()).toEqual([
    "shutdown step failed (gateway lifetime sidecars): Cannot find module 'rotated-chunk.js'",
  ]);
  const trace = traceMessages();
  const failedStep = trace.findIndex((line) =>
    line.includes("shutdown.gateway-lifetime-sidecars "),
  );
  const nextStep = trace.findIndex((line) => line.includes("shutdown.gateway-close.begin "));
  expect(failedStep).toBeGreaterThanOrEqual(0);
  expect(nextStep).toBeGreaterThan(failedStep);
});
