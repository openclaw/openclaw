import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  countActiveDescendantRunsMock,
  dispatchCronDeliveryMock,
  isCliProviderMock,
  isHeartbeatOnlyResponseMock,
  listDescendantRunsForRequesterMock,
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  mockRunCronFallbackPassthrough,
  pickLastNonEmptyTextFromPayloadsMock,
  resolveCronPayloadOutcomeMock,
  resolveCronDeliveryPlanMock,
  runEmbeddedPiAgentMock,
  runCliAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function requireEmbeddedAgentCall(index: number): { prompt?: string } {
  const call = runEmbeddedPiAgentMock.mock.calls[index]?.[0] as { prompt?: string } | undefined;
  if (!call) {
    throw new Error(`Expected embedded PI agent call ${index}`);
  }
  return call;
}

function requireDeliveryRequest(): {
  skipHeartbeatDelivery?: boolean;
  deliveryPayloads?: unknown;
  emptyOutputHadFreshDescendants?: boolean;
} {
  const request = dispatchCronDeliveryMock.mock.calls[0]?.[0] as
    | {
        skipHeartbeatDelivery?: boolean;
        deliveryPayloads?: unknown;
        emptyOutputHadFreshDescendants?: boolean;
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
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());
    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(expectedFallbackCalls);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(expectedAgentCalls);
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
    runEmbeddedPiAgentMock
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
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "SF is 62F and SD is 67F. SD is warmer by 5F." }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    mockRunCronFallbackPassthrough();
    await runTurnAndExpectOk(1, 1);
  });

  it("does not retry over a fatal structured failure signal", async () => {
    usePayloadTextExtraction();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
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
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toBe("SYSTEM_RUN_DENIED: approval required");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
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
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
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
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

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
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
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

  it("marks empty-output delivery when a fresh descendant already settled", async () => {
    usePayloadTextExtraction();
    resolveCronPayloadOutcomeMock.mockReturnValue({
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayload: undefined,
      deliveryPayloads: [],
      deliveryPayloadHasStructuredContent: false,
      hasFatalErrorPayload: false,
      embeddedRunError: undefined,
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "   " }],
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

    const deliveryRequest = requireDeliveryRequest();
    expect(deliveryRequest.deliveryPayloads).toEqual([]);
    expect(deliveryRequest.emptyOutputHadFreshDescendants).toBe(true);
  });

  it("runs one no-tools repair pass when final cron output has no deliverable text", async () => {
    usePayloadTextExtraction();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "123",
    });
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "   " }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "Morning report ready." }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

    mockRunCronFallbackPassthrough();
    await runTurnAndExpectOk(2, 2);

    const repairCall = runEmbeddedPiAgentMock.mock.calls.at(1)?.[0] as
      | { disableTools?: boolean; prompt?: string }
      | undefined;
    expect(repairCall?.disableTools).toBe(true);
    expect(repairCall?.prompt).toContain("produced no deliverable user-visible text");
    expect(repairCall?.prompt).toContain("Original cron task:");
    expect(repairCall?.prompt).toContain("[cron:test-job Test Job] test");
    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(requireDeliveryRequest().deliveryPayloads).toEqual([{ text: "Morning report ready." }]);
  });

  it("uses explicit CLI repair mode and resumes the first CLI session", async () => {
    usePayloadTextExtraction();
    isCliProviderMock.mockReturnValue(true);
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "123",
    });
    runCliAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "   " }],
        meta: {
          agentMeta: {
            sessionId: "first-cli-session",
            usage: { input: 10, output: 20 },
          },
        },
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "CLI repair ready." }],
        meta: { agentMeta: { sessionId: "first-cli-session", usage: { input: 10, output: 20 } } },
      });

    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledTimes(2);
    const repairCall = runCliAgentMock.mock.calls.at(1)?.[0] as
      | {
          cliSessionId?: string;
          disableBundleMcp?: boolean;
          disableTools?: boolean;
          prompt?: string;
        }
      | undefined;
    expect(repairCall?.cliSessionId).toBe("first-cli-session");
    expect(repairCall?.disableBundleMcp).toBe(true);
    expect(repairCall?.disableTools).toBeUndefined();
    expect(repairCall?.prompt).toContain("produced no deliverable user-visible text");
    expect(repairCall?.prompt).toContain("Original cron task:");
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("attempting CLI repair pass with bundled MCP disabled"),
    );
    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(requireDeliveryRequest().deliveryPayloads).toEqual([{ text: "CLI repair ready." }]);
  });

  it("recomputes empty-output repair constraints for each fallback runtime candidate", async () => {
    usePayloadTextExtraction();
    isCliProviderMock.mockImplementation((provider?: string) => provider === "claude-cli");
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "123",
    });
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "   " }],
      meta: {
        agentMeta: {
          provider: "claude-cli",
          sessionId: "first-cli-session",
          usage: { input: 10, output: 20 },
        },
      },
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Embedded repair ready." }],
      meta: { agentMeta: { provider: "openai", usage: { input: 10, output: 20 } } },
    });
    runWithModelFallbackMock
      .mockImplementationOnce(async ({ run }) => {
        const result = await run("claude-cli", "claude");
        return { result, provider: "claude-cli", model: "claude", attempts: [] };
      })
      .mockImplementationOnce(async ({ run }) => {
        const result = await run("openai", "gpt-5.4");
        return { result, provider: "openai", model: "gpt-5.4", attempts: [] };
      });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const repairCall = runEmbeddedPiAgentMock.mock.calls.at(0)?.[0] as
      | { disableTools?: boolean; prompt?: string }
      | undefined;
    expect(repairCall?.disableTools).toBe(true);
    expect(repairCall?.prompt).toContain("produced no deliverable user-visible text");
    expect(requireDeliveryRequest().deliveryPayloads).toEqual([{ text: "Embedded repair ready." }]);
  });

  it("preserves external-hook non-owner scope during CLI empty-output repair", async () => {
    usePayloadTextExtraction();
    isCliProviderMock.mockReturnValue(true);
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "123",
    });
    runCliAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "   " }],
        meta: {
          agentMeta: {
            sessionId: "external-hook-cli-session",
            usage: { input: 10, output: 20 },
          },
        },
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "External hook CLI repair ready." }],
        meta: {
          agentMeta: {
            sessionId: "external-hook-cli-session",
            usage: { input: 10, output: 20 },
          },
        },
      });

    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: {
          payload: {
            kind: "agentTurn",
            message: "test",
            externalContentSource: "webhook",
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledTimes(2);
    const firstCall = runCliAgentMock.mock.calls.at(0)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    const repairCall = runCliAgentMock.mock.calls.at(1)?.[0] as
      | {
          cliSessionId?: string;
          disableBundleMcp?: boolean;
          senderIsOwner?: boolean;
        }
      | undefined;
    expect(firstCall?.senderIsOwner).toBe(false);
    expect(repairCall?.senderIsOwner).toBe(false);
    expect(repairCall?.cliSessionId).toBe("external-hook-cli-session");
    expect(repairCall?.disableBundleMcp).toBe(true);
    expect(requireDeliveryRequest().deliveryPayloads).toEqual([
      { text: "External hook CLI repair ready." },
    ]);
  });

  it("fails explicitly when the no-tools repair pass still has no deliverable text", async () => {
    usePayloadTextExtraction();
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "   " }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "\n\n" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toContain("repair pass did not recover a final reply");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
  });

  it("fails explicitly when the repair pass returns a silent NO_REPLY token", async () => {
    usePayloadTextExtraction();
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "   " }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "NO_REPLY" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toContain("repair pass did not recover a final reply");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
  });
});
