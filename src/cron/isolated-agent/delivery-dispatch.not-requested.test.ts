/**
 * Tests for issue #69281: Cron jobs with delivery.mode "none" incorrectly marked "not-delivered"
 *
 * Bug: When a cron job is configured with delivery.mode "none", the dispatch function
 * returned `delivered: false` instead of `delivered: undefined`. This caused
 * resolveDeliveryStatus to incorrectly return "not-delivered" instead of "not-requested".
 *
 * Fix: When delivery is not requested (deliveryRequested === false), return
 * `delivered: undefined` to distinguish from an actual failed delivery attempt.
 */

import { describe, expect, it } from "vitest";
import { dispatchCronDelivery } from "./delivery-dispatch.js";

// Minimal test - the key fix is that when deliveryRequested is false,
// we return delivered: undefined
describe("dispatchCronDelivery - Issue #69281", () => {
  function makeMinimalJob(): any {
    return {
      id: "test-job",
      name: "test job",
      schedule: "1h",
      payload: { kind: "message", message: "test" },
      delivery: { mode: "none" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function makeMinimalParams(overrides?: any): any {
    const job = makeMinimalJob();
    return {
      cfg: {} as any,
      cfgWithAgentDefaults: {} as any,
      deps: {} as any,
      job,
      agentId: "test-agent",
      agentSessionKey: "test-session",
      runStartedAt: Date.now(),
      runEndedAt: Date.now() + 1000,
      timeoutMs: 30000,
      resolvedDelivery: { ok: true, channel: "last", to: "test" },
      deliveryRequested: false,
      skipHeartbeatDelivery: false,
      skipMessagingToolDelivery: false,
      deliveryBestEffort: false,
      deliveryPayloadHasStructuredContent: false,
      deliveryPayloads: [],
      synthesizedText: undefined,
      summary: undefined,
      outputText: undefined,
      telemetry: undefined,
      abortSignal: undefined,
      isAborted: () => false,
      abortReason: () => "abort",
      withRunSession: (result: any) => ({
        ...result,
        sessionId: "test-session-id",
        sessionKey: "test-session",
      }),
      ...overrides,
    };
  }

  it("returns delivered: undefined when deliveryRequested is false", async () => {
    const params = makeMinimalParams({
      deliveryRequested: false,
    });

    const result = await dispatchCronDelivery(params);

    expect(result.delivered).toBeUndefined();
    expect(result.deliveryAttempted).toBeUndefined();
  });

  it("returns delivered: undefined with mode none", async () => {
    const params = makeMinimalParams({
      deliveryRequested: false,
      job: {
        ...makeMinimalJob(),
        delivery: { mode: "none" },
      },
    });

    const result = await dispatchCronDelivery(params);

    expect(result.delivered).toBeUndefined();
    expect(result.deliveryAttempted).toBeUndefined();
  });

  it("preserves summary, outputText, synthesizedText when delivery not requested", async () => {
    const params = makeMinimalParams({
      deliveryRequested: false,
      summary: "test summary",
      outputText: "test output",
      synthesizedText: "test synthesized",
    });

    const result = await dispatchCronDelivery(params);

    expect(result.delivered).toBeUndefined();
    expect(result.summary).toBe("test summary");
    expect(result.outputText).toBe("test output");
    expect(result.synthesizedText).toBe("test synthesized");
  });
});
