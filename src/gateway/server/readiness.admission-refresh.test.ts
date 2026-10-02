import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildRuntimeReadiness, type ReadinessCondition } from "../../readiness/conditions.js";
import { createGatewayReadinessIdentity } from "../../readiness/subjects.js";
import { createReadinessChecker, evaluateConfiguredGatewayReadiness } from "./readiness.js";

type ReadinessResult = Awaited<ReturnType<ReturnType<typeof createReadinessChecker>>>;

const FIVE_MIN_MS = 5 * 60_000;

function testReadinessIdentity() {
  return createGatewayReadinessIdentity({ createGatewayInstanceId: () => "gateway-test" });
}

function gatewaySnapshot(draining = false): ReadinessResult {
  const conditions: ReadinessCondition[] = [
    {
      type: "GatewayStartupComplete",
      status: "True",
      requirement: "required",
      reason: "GatewayStartupComplete",
      message: "Gateway startup dependencies are complete.",
    },
    {
      type: "GatewayAcceptingWork",
      status: draining ? "False" : "True",
      requirement: "required",
      reason: draining ? "GatewayDraining" : "GatewayAcceptingWork",
      message: draining
        ? "Gateway is draining and is not accepting new work."
        : "Gateway is accepting new work.",
    },
    {
      type: "ChannelRuntimeReady",
      status: draining ? "Unknown" : "True",
      requirement: "required",
      reason: draining ? "ChannelRuntimeNotChecked" : "ChannelRuntimeReady",
      message: draining
        ? "Channel runtime health was not evaluated on this readiness pass."
        : "Selected channel runtimes are ready.",
    },
    {
      type: "EventLoopHealthy",
      status: "Unknown",
      requirement: "advisory",
      reason: "EventLoopStatusUnavailable",
      message: "Event-loop health is not available yet.",
    },
  ];
  return {
    ready: !draining,
    failing: draining ? ["gateway-draining"] : [],
    uptimeMs: FIVE_MIN_MS,
    conditions,
  };
}

describe("configured Gateway admission refresh", () => {
  it("rechecks Gateway admission after an awaited runtime provider settles", async () => {
    const runtimeStarted = createDeferred();
    const releaseRuntime = createDeferred();
    let draining = false;
    const evaluateGateway = vi.fn(() => gatewaySnapshot(draining));

    const evaluation = evaluateConfiguredGatewayReadiness({
      config: { gateway: { readiness: {} } },
      identity: testReadinessIdentity(),
      evaluateGateway,
      evaluateRuntime: async () => {
        runtimeStarted.resolve();
        await releaseRuntime.promise;
        return buildRuntimeReadiness({ configLoaded: true, gateway: "responding" });
      },
    });

    await runtimeStarted.promise;
    draining = true;
    releaseRuntime.resolve();

    const result = await evaluation;
    expect(evaluateGateway).toHaveBeenCalledTimes(2);
    expect(result.ready).toBe(false);
    expect(result.failures).toContain("GatewayDraining");
    expect(result.conditions).toContainEqual(
      expect.objectContaining({
        type: "GatewayAcceptingWork",
        status: "False",
        reason: "GatewayDraining",
      }),
    );
  });

  it("returns current admission evidence when extended evaluation times out", async () => {
    let draining = false;
    const evaluateGateway = vi.fn(() => gatewaySnapshot(draining));
    const result = await evaluateConfiguredGatewayReadiness({
      config: { gateway: { readiness: {} } },
      identity: testReadinessIdentity(),
      evaluateGateway,
      evaluateRuntime: () => {
        draining = true;
        return new Promise<never>(() => {});
      },
      timeoutMs: 5,
    });

    expect(evaluateGateway).toHaveBeenCalledTimes(2);
    expect(result.ready).toBe(false);
    expect(result.failures).toEqual([
      "ReadinessEvaluationTimedOut",
      "GatewayDraining",
      "ChannelRuntimeNotChecked",
    ]);
    expect(result.conditions).toContainEqual({
      type: "ReadinessEvaluationComplete",
      subjectRef: "openclaw/gateway/current",
      status: "Unknown",
      requirement: "required",
      reason: "ReadinessEvaluationTimedOut",
      message: "Readiness evaluation did not complete within its bounded deadline.",
    });
    expect(result.conditions).toContainEqual(
      expect.objectContaining({
        type: "GatewayAcceptingWork",
        status: "False",
        reason: "GatewayDraining",
      }),
    );
    expect(result.conditions?.[0]?.type).toBe("ReadinessEvaluationComplete");
  });

  it("keeps an asynchronous failure-path refresh inside the original deadline", async () => {
    vi.useFakeTimers();
    try {
      const evaluateGateway = vi
        .fn<() => ReadinessResult | Promise<ReadinessResult>>()
        .mockReturnValueOnce(gatewaySnapshot())
        .mockReturnValueOnce(new Promise<ReadinessResult>(() => {}));
      const evaluation = evaluateConfiguredGatewayReadiness({
        config: { gateway: { readiness: {} } },
        identity: testReadinessIdentity(),
        evaluateGateway,
        evaluateRuntime: () => new Promise<never>(() => {}),
        timeoutMs: 100,
      });

      await vi.advanceTimersByTimeAsync(100);

      await expect(evaluation).resolves.toMatchObject({
        ready: false,
        failures: ["ReadinessEvaluationTimedOut"],
      });
      expect(evaluateGateway).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
