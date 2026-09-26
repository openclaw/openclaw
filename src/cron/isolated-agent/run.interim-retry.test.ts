import { describe, expect, it, vi } from "vitest";
import { onInternalDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  countActiveDescendantRunsMock,
  deriveSessionTotalTokensMock,
  dispatchCronDeliveryMock,
  listDescendantRunsForRequesterMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  pickLastNonEmptyTextFromPayloadsMock,
  resolveCronDeliveryPlanMock,
  resolveCronPayloadOutcomeMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function requireEmbeddedAgentCall(index: number): {
  prompt?: string;
  suppressNextUserMessagePersistence?: boolean;
  userTurnTranscriptRecorder?: {
    markRuntimePersisted: (message: { role: "user"; content: string }) => void;
  };
} {
  const call = runEmbeddedAgentMock.mock.calls[index]?.[0] as
    | {
        prompt?: string;
        suppressNextUserMessagePersistence?: boolean;
        userTurnTranscriptRecorder?: {
          markRuntimePersisted: (message: { role: "user"; content: string }) => void;
        };
      }
    | undefined;
  if (!call) {
    throw new Error(`Expected embedded OpenClaw agent call ${index}`);
  }
  return call;
}

function requireDeliveryRequest(): {
  skipDelivery?: string;
  deliveryPayloads?: unknown;
} {
  const request = dispatchCronDeliveryMock.mock.calls[0]?.[0] as
    | {
        skipDelivery?: string;
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

  it.each([20, Number.NaN])(
    "regression, retries once when cron returns interim acknowledgement with initial total %s and no descendants were spawned",
    async (initialTotal) => {
      const onExecutionStarted = vi.fn();
      const cronSession = makeCronSession();
      resolveCronSessionMock.mockReturnValue(cronSession);
      const { deriveSessionTotalTokens } = await import("../../agents/usage.js");
      deriveSessionTotalTokensMock.mockImplementation(deriveSessionTotalTokens);
      usePayloadTextExtraction();
      runEmbeddedAgentMock
        .mockImplementationOnce(async (request) => {
          request.onExecutionStarted?.();
          request.userTurnTranscriptRecorder?.markRuntimePersisted({
            role: "user",
            content: "test",
          });
          return {
            payloads: [
              {
                text: "On it, grabbing current SF and SD weather now and I will summarize right after both come back.",
              },
            ],
            meta: {
              agentMeta: {
                usage: {
                  input: 10,
                  output: 20,
                  cacheRead: 3,
                  total: initialTotal,
                  cost: { total: 0.01 },
                },
                lastCallUsage: { input: 10, output: 20, cacheRead: 3 },
              },
            },
          };
        })
        .mockImplementationOnce(async (request) => {
          request.onExecutionStarted?.();
          return {
            payloads: [
              {
                text: "SF is 62F and SD is 67F. SD is warmer by 5F.",
              },
            ],
            meta: {
              agentMeta: {
                usage: { input: 30, output: 40, cacheRead: 7, total: 100, cost: { total: 0.02 } },
                lastCallUsage: { input: 9, output: 4, cacheRead: 2 },
              },
            },
          };
        });

      mockRunCronFallbackPassthrough();
      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({ onExecutionStarted }),
      );
      expect(result.status).toBe("ok");
      expect(result.usage).toEqual({
        input_tokens: 40,
        output_tokens: 60,
        cache_read_tokens: 10,
        total_tokens: 133,
      });
      expect(cronSession.sessionEntry).toMatchObject({
        inputTokens: 40,
        outputTokens: 60,
        cacheRead: 10,
        totalTokens: 11,
        estimatedCostUsd: 0.03,
      });
      expect(runWithModelFallbackMock).toHaveBeenCalledTimes(2);
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
      const firstCall = requireEmbeddedAgentCall(0);
      const continuationCall = requireEmbeddedAgentCall(1);
      expect(continuationCall.prompt).toContain("previous response was only an acknowledgement");
      expect(continuationCall.userTurnTranscriptRecorder).not.toBe(
        firstCall.userTurnTranscriptRecorder,
      );
      expect(firstCall.suppressNextUserMessagePersistence).toBe(false);
      expect(continuationCall.suppressNextUserMessagePersistence).toBe(false);
      expect(onExecutionStarted.mock.calls.map(([info]) => info?.isFallback)).toEqual([
        undefined,
        undefined,
      ]);
    },
  );

  it.each([true, false])(
    "refreshes a persistent session after a context-only retry with final context available=%s",
    async (available) => {
      usePayloadTextExtraction();
      const cronSession = makeCronSession();
      Object.assign(cronSession.sessionEntry, {
        inputTokens: 50,
        outputTokens: 20,
        cacheRead: 10,
        cacheWrite: 5,
        estimatedCostUsd: 0.01,
      });
      cronSession.sessionEntry.totalTokens = 99;
      cronSession.sessionEntry.totalTokensFresh = true;
      resolveCronSessionMock.mockReturnValue(cronSession);
      const { deriveSessionTotalTokens } = await import("../../agents/usage.js");
      deriveSessionTotalTokensMock.mockImplementation(deriveSessionTotalTokens);
      const firstUsage = { contextUsage: { state: "available", promptTokens: 21 } } as const;
      const finalUsage = {
        contextUsage: available
          ? ({ state: "available", promptTokens: 37 } as const)
          : ({ state: "unavailable" } as const),
      };
      runEmbeddedAgentMock
        .mockResolvedValueOnce({
          payloads: [{ text: "On it, checking the report now." }],
          meta: { agentMeta: { usage: firstUsage, lastCallUsage: firstUsage } },
        })
        .mockResolvedValueOnce({
          payloads: [{ text: "The report is complete." }],
          meta: { agentMeta: { usage: finalUsage, lastCallUsage: finalUsage } },
        });
      mockRunCronFallbackPassthrough();

      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          job: makeIsolatedAgentJobFixture({ sessionTarget: "session:cron-proof" }),
          sessionKey: "agent:default:cron-proof",
        }),
      );

      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
      expect(cronSession.sessionEntry).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
      expect(cronSession.sessionEntry.estimatedCostUsd).toBeUndefined();
      expect(cronSession.sessionEntry.totalTokens).toBe(available ? 37 : undefined);
      expect(cronSession.sessionEntry.totalTokensFresh).toBe(available);
    },
  );

  it.each([true, false])(
    "keeps per-model prices and diagnostics when prior pricing is available=%s",
    async (priced) => {
      usePayloadTextExtraction();
      const cronSession = makeCronSession();
      resolveCronSessionMock.mockReturnValue(cronSession);
      const firstModel = priced ? "first" : "unpriced";
      runEmbeddedAgentMock
        .mockResolvedValueOnce({
          payloads: [{ text: "On it, checking the report now." }],
          meta: {
            agentMeta: {
              provider: "cron-usage-test",
              model: firstModel,
              contextTokens: 2000,
              usage: { input: 10, output: 20 },
              diagnosticUsage: { input: 100, output: 200, cost: { total: 0.005 } },
              lastCallUsage: { input: 8, output: 2 },
            },
          },
        })
        .mockResolvedValueOnce({
          payloads: [{ text: "The report is complete." }],
          meta: {
            agentMeta: {
              provider: "cron-usage-test",
              model: "final",
              contextTokens: 4000,
              usage: { input: 30, output: 40 },
              diagnosticUsage: { input: 1000, output: 2000, cost: { total: 0.01 } },
              lastCallUsage: { input: 25, output: 5 },
            },
          },
        });
      mockRunCronFallbackPassthrough();
      const usageEvents: unknown[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type === "model.usage") {
          usageEvents.push(event);
        }
      });
      try {
        const result = await runCronIsolatedAgentTurn(
          makeIsolatedAgentParamsFixture({
            cfg: {
              models: {
                providers: {
                  "cron-usage-test": {
                    baseUrl: "https://example.invalid",
                    api: "openai-responses",
                    models: [
                      {
                        id: "first",
                        name: "First",
                        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                      },
                      {
                        id: "final",
                        name: "Final",
                        cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
                      },
                    ],
                  },
                },
              },
            },
          }),
        );
        expect(result.status).toBe("ok");
        expect(result.usage).toEqual({ input_tokens: 40, output_tokens: 60, total_tokens: 100 });
        if (priced) {
          expect(cronSession.sessionEntry.estimatedCostUsd).toBeCloseTo(0.0003, 9);
        } else {
          expect(cronSession.sessionEntry.estimatedCostUsd).toBeUndefined();
        }
        expect(usageEvents).toMatchObject([
          {
            provider: "cron-usage-test",
            model: firstModel,
            usage: { input: 100, output: 200, total: 300 },
            context: { limit: 2000, used: 8 },
            costUsd: 0.005,
          },
          {
            provider: "cron-usage-test",
            model: "final",
            usage: { input: 1000, output: 2000, total: 3000 },
            context: { limit: 4000, used: 25 },
            costUsd: 0.01,
          },
        ]);
      } finally {
        unsubscribe();
      }
    },
  );

  it("delivers only the final result after an earlier heartbeat acknowledgement", async () => {
    const finalResult = "Critical deployment failure: database unavailable.";
    const { resolveCronPayloadOutcome } =
      await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
    usePayloadTextExtraction();
    resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "123",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "HEARTBEAT_OK" }, { text: finalResult }],
      meta: {
        finalAssistantVisibleText: finalResult,
        agentMeta: { usage: { input: 10, output: 20 } },
      },
    });

    mockRunCronFallbackPassthrough();
    const result = await runTurnAndExpectOk(1, 1);

    expect(result.delivered).toBe(true);
    expect(requireDeliveryRequest()).toMatchObject({
      skipDelivery: undefined,
      deliveryPayloads: [{ text: finalResult }],
    });
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
    expect(deliveryRequest.skipDelivery).toBeUndefined();
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
        execution: { status: "running", startedAt: Date.now() + 60_000 },
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
