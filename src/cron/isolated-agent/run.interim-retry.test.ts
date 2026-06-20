// Interim retry tests cover retry behavior for incomplete isolated cron runs.
import { describe, expect, it } from "vitest";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  cleanupDirectCronSessionMock,
  countActiveDescendantRunsMock,
  dispatchCronDeliveryMock,
  isHeartbeatOnlyResponseMock,
  listDescendantRunsForRequesterMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  pickLastNonEmptyTextFromPayloadsMock,
  resolveCronDeliveryPlanMock,
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

  it("fails closed without delivering injected self-debug text when the runner exhausts the unknown-tool loop guard (#92535)", async () => {
    // Real-world reproduction from issue #92535: the model kept calling an
    // unavailable tool (`process`) until the embedded runner's unknown-tool
    // loop guard rewrote the assistant message into canned self-debug text
    // ("I can't use the tool 'process' here because it isn't available...").
    // The runner now surfaces that condition as a fatal failure signal with
    // `bypassCronDelivery: true` so cron must NOT dispatch the injected text
    // to Telegram; the cleanup branch retires the cron session and reports
    // an operator-facing error instead.
    usePayloadTextExtraction();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "123",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [
        {
          text: "I can't use the tool \"process\" here because it isn't available. I need to stop retrying it and answer without that tool.",
        },
      ],
      meta: {
        agentMeta: { usage: { input: 10, output: 20 } },
        finalAssistantVisibleText:
          "I can't use the tool \"process\" here because it isn't available. I need to stop retrying it and answer without that tool.",
        failureSignal: {
          kind: "tool_unavailable_exhausted",
          source: "runner",
          toolName: "process",
          code: "TOOL_UNAVAILABLE_EXHAUSTED",
          message:
            'Cron run aborted: model exhausted retries on unavailable tool "process".',
          fatalForCron: true,
          bypassCronDelivery: true,
        },
      },
    });

    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    // Delivery dispatch must never see the injected self-debug text.
    expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
    // The cron session is cleaned up just like the existing fatal
    // structured-payload path so direct-delivery sessions do not leak.
    expect(cleanupDirectCronSessionMock).toHaveBeenCalledWith({
      job: expect.objectContaining({ id: expect.any(String) }),
      agentSessionKey: expect.any(String),
      sessionId: expect.any(String),
      retireReason: "cron-delete-after-run-fatal-error",
    });
    // The run is reported as an error with the operator-facing summary, not
    // the canned assistant text.
    expect(result.status).toBe("error");
    expect(result.error).toBe(
      'Cron run aborted: model exhausted retries on unavailable tool "process".',
    );
    expect(result.delivered).toBe(false);
    expect(result.deliveryAttempted).toBe(false);
  });

  it("still delivers ordinary fatal failure signals as synthesized error payloads", async () => {
    // Regression guard: the bypass branch above must NOT fire for normal
    // fatal signals (e.g. SYSTEM_RUN_DENIED) that already rely on the
    // synthesized-error delivery path. Without an explicit
    // `bypassCronDelivery: true`, dispatch must still be called.
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
    await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
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
