// Interim retry tests cover retry behavior for incomplete isolated cron runs.
import { describe, expect, it } from "vitest";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  countActiveDescendantRunsMock,
  dispatchCronDeliveryMock,
  isCliProviderMock,
  isHeartbeatOnlyResponseMock,
  listDescendantRunsForRequesterMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  pickLastNonEmptyTextFromPayloadsMock,
  resolveCronDeliveryPlanMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function requireEmbeddedAgentCall(index: number): { prompt?: string } {
  const call = runEmbeddedAgentMock.mock.calls[index]?.[0] as { prompt?: string } | undefined;
  if (!call) {
    throw new Error(`Expected embedded OpenClaw agent call ${index}`);
  }
  return call;
}

function requireDeliveryRequest(): {
  skipHeartbeatDelivery?: boolean;
  deliveryPayloads?: unknown;
} {
  const request = dispatchCronDeliveryMock.mock.calls[0]?.[0] as
    | {
        skipHeartbeatDelivery?: boolean;
        deliveryPayloads?: unknown;
      }
    | undefined;
  if (!request) {
    throw new Error("Expected cron delivery request");
  }
  return request;
}

describe("runCronIsolatedAgentTurn — interim ack retry", () => {
  setupRunCronIsolatedAgentTurnSuite();

  const runTurnAndExpectOk = async (expectedFallbackCalls: number, expectedAgentCalls: number) => {
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());
    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(expectedFallbackCalls);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(expectedAgentCalls);
    return result;
  };

  const usePayloadTextExtraction = () => {
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      (payloads?: Array<{ text?: string }>) => {
        for (let idx = (payloads?.length ?? 0) - 1; idx >= 0; idx -= 1) {
          const text = payloads?.[idx]?.text;
          if (typeof text === "string" && text.trim()) {
            return text;
          }
        }
        return "";
      },
    );
  };

  it("regression, retries once when cron returns interim acknowledgement and no descendants were spawned", async () => {
    usePayloadTextExtraction();
    runEmbeddedAgentMock
      .mockResolvedValueOnce({
        payloads: [
          {
            text: "On it, grabbing current SF and SD weather now and I will summarize right after both come back.",
          },
        ],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "SF is 62F and SD is 67F. SD is warmer by 5F." }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

    mockRunCronFallbackPassthrough();
    await runTurnAndExpectOk(2, 2);
    expect(requireEmbeddedAgentCall(1).prompt).toContain(
      "previous response was only an acknowledgement",
    );
  });

  it("does not retry when the first turn is already a concrete result", async () => {
    usePayloadTextExtraction();
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "SF is 62F and SD is 67F. SD is warmer by 5F." }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    mockRunCronFallbackPassthrough();
    await runTurnAndExpectOk(1, 1);
  });

  it("does not retry over a fatal structured failure signal", async () => {
    usePayloadTextExtraction();
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "On it, retrying now." }],
      meta: {
        agentMeta: { usage: { input: 10, output: 20 } },
        failureSignal: {
          kind: "execution_denied",
          source: "tool",
          toolName: "exec",
          code: "SYSTEM_RUN_DENIED",
          message: "SYSTEM_RUN_DENIED: approval required",
          fatalForCron: true,
        },
      },
    });

    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe("SYSTEM_RUN_DENIED: approval required");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });

  it("delivers synthesized fatal failure signals even when the original payloads are empty", async () => {
    usePayloadTextExtraction();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "123",
    });
    isHeartbeatOnlyResponseMock.mockReturnValue(true);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        agentMeta: { usage: { input: 10, output: 20 } },
        failureSignal: {
          kind: "execution_denied",
          source: "tool",
          toolName: "exec",
          code: "SYSTEM_RUN_DENIED",
          message: "SYSTEM_RUN_DENIED: approval required",
          fatalForCron: true,
        },
      },
    });

    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe("SYSTEM_RUN_DENIED: approval required");
    const deliveryRequest = requireDeliveryRequest();
    expect(deliveryRequest.skipHeartbeatDelivery).toBe(false);
    expect(deliveryRequest.deliveryPayloads).toEqual([
      { text: "SYSTEM_RUN_DENIED: approval required", isError: true },
    ]);
  });

  it("does not retry when descendants were spawned in this run even if they already settled", async () => {
    usePayloadTextExtraction();
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "On it, I spawned a subagent and it will auto-announce when done." }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });
    listDescendantRunsForRequesterMock.mockReturnValue([
      {
        startedAt: Date.now() + 60_000,
      },
    ]);
    countActiveDescendantRunsMock.mockReturnValue(0);

    mockRunCronFallbackPassthrough();
    await runTurnAndExpectOk(1, 1);
    expect(listDescendantRunsForRequesterMock).toHaveBeenCalledWith(
      "agent:default:cron:test:run:test-session-id",
    );
    expect(countActiveDescendantRunsMock).toHaveBeenCalledWith(
      "agent:default:cron:test:run:test-session-id",
    );
  });
});

describe("runCronIsolatedAgentTurn — CLI interim ack retry with cleanup", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("passes cleanupCliLiveSessionOnRunEnd on both the initial and retry CLI runs", async () => {
    isCliProviderMock.mockReturnValue(true);
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      (payloads?: Array<{ text?: string }>) => {
        for (let idx = (payloads?.length ?? 0) - 1; idx >= 0; idx -= 1) {
          const text = payloads?.[idx]?.text;
          if (typeof text === "string" && text.trim()) {
            return text;
          }
        }
        return "";
      },
    );
    // First call: interim acknowledgement
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [
        {
          text: "On it, grabbing current SF and SD weather now and I will summarize right after both come back.",
        },
      ],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });
    // Second call: real result after retry
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "SF is 62F and SD is 67F. SD is warmer by 5F." }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    expect(runCliAgentMock).toHaveBeenCalledTimes(2);

    // Both calls must pass cleanupCliLiveSessionOnRunEnd: true
    for (const [callIdx, callArgs] of runCliAgentMock.mock.calls.entries()) {
      const params = callArgs[0] as { cleanupCliLiveSessionOnRunEnd?: boolean };
      expect(params.cleanupCliLiveSessionOnRunEnd).toBe(true);
    }

    // Second call's prompt must contain the continuation message
    const retryParams = runCliAgentMock.mock.calls[1]?.[0] as { prompt?: string } | undefined;
    expect(retryParams?.prompt).toContain("previous response was only an acknowledgement");
  });

  it("still passes cleanupCliLiveSessionOnRunEnd when the first turn is already a concrete result (no retry)", async () => {
    isCliProviderMock.mockReturnValue(true);
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      (payloads?: Array<{ text?: string }>) => {
        for (let idx = (payloads?.length ?? 0) - 1; idx >= 0; idx -= 1) {
          const text = payloads?.[idx]?.text;
          if (typeof text === "string" && text.trim()) {
            return text;
          }
        }
        return "";
      },
    );
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "SF is 62F and SD is 67F. SD is warmer by 5F." }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock).toHaveBeenCalledTimes(1);

    const params = runCliAgentMock.mock.calls[0]?.[0] as {
      cleanupCliLiveSessionOnRunEnd?: boolean;
    };
    expect(params.cleanupCliLiveSessionOnRunEnd).toBe(true);
  });
});
