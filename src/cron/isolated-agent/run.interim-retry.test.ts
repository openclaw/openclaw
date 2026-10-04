import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { onInternalDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { mockCall, mockFirstObjectArg } from "../../test-utils/mock-call-assertions.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  deriveSessionTotalTokensMock,
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  pickLastNonEmptyTextFromPayloadsMock,
  readDescendantExecutionStateMock,
  resolveCronDeliveryPlanMock,
  resolveCronPayloadOutcomeMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const requireRecord = createRequireRecord("record", "expected-label-object");
const interimText = "On it, checking the report now.";
const finalText = "The report is complete.";
const denied = {
  kind: "execution_denied",
  source: "tool",
  toolName: "exec",
  code: "SYSTEM_RUN_DENIED",
  message: "SYSTEM_RUN_DENIED: approval required",
  fatalForCron: true,
};
function agentResult(
  text: string | undefined,
  agentMeta: Record<string, unknown> = { usage: { input: 10, output: 20 } },
  meta: Record<string, unknown> = {},
) {
  return { payloads: text === undefined ? [] : [{ text }], meta: { agentMeta, ...meta } };
}
function prepareSession() {
  const session = makeCronSession();
  resolveCronSessionMock.mockReturnValue(session);
  return session;
}
async function useRealTokenDerivation() {
  const { deriveSessionTotalTokens } = await import("../../agents/usage.js");
  deriveSessionTotalTokensMock.mockImplementation(deriveSessionTotalTokens);
}

describe("runCronIsolatedAgentTurn — interim ack retry", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => {
    mockRunCronFallbackPassthrough();
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      (payloads?: Array<{ text?: string }>) =>
        payloads?.findLast((payload) => typeof payload.text === "string" && payload.text.trim())
          ?.text ?? "",
    );
  });

  it("retries an interim acknowledgement without descendants and accounts for an invalid initial total", async () => {
    const onExecutionStarted = vi.fn();
    const cronSession = prepareSession();
    await useRealTokenDerivation();
    runEmbeddedAgentMock
      .mockImplementationOnce(async (request) => {
        request.onExecutionStarted?.();
        request.userTurnTranscriptRecorder?.markRuntimePersisted({ role: "user", content: "test" });
        return agentResult(
          "On it, grabbing current SF and SD weather now and I will summarize right after both come back.",
          {
            usage: {
              input: 10,
              output: 20,
              cacheRead: 3,
              total: Number.NaN,
              cost: { total: 0.01 },
            },
            lastCallUsage: { input: 10, output: 20, cacheRead: 3 },
          },
        );
      })
      .mockImplementationOnce(async (request) => {
        request.onExecutionStarted?.();
        return agentResult("SF is 62F and SD is 67F. SD is warmer by 5F.", {
          usage: { input: 30, output: 40, cacheRead: 7, total: 100, cost: { total: 0.02 } },
          lastCallUsage: { input: 9, output: 4, cacheRead: 2 },
        });
      });
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
    const firstCall = requireRecord(mockCall(runEmbeddedAgentMock, 0)[0], "first call");
    const continuationCall = requireRecord(
      mockCall(runEmbeddedAgentMock, 1)[0],
      "continuation call",
    );
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
  });

  it.each([true, false])(
    "refreshes a persistent session after a context-only retry with final context available=%s",
    async (available) => {
      const cronSession = prepareSession();
      Object.assign(cronSession.sessionEntry, {
        inputTokens: 50,
        outputTokens: 20,
        cacheRead: 10,
        cacheWrite: 5,
        estimatedCostUsd: 0.01,
        totalTokens: 99,
        totalTokensFresh: true,
      });
      await useRealTokenDerivation();
      const firstUsage = { contextUsage: { state: "available", promptTokens: 21 } };
      const finalUsage = {
        contextUsage: available
          ? { state: "available", promptTokens: 37 }
          : { state: "unavailable" },
      };
      runEmbeddedAgentMock
        .mockResolvedValueOnce(
          agentResult(interimText, { usage: firstUsage, lastCallUsage: firstUsage }),
        )
        .mockResolvedValueOnce(
          agentResult(finalText, { usage: finalUsage, lastCallUsage: finalUsage }),
        );
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
      const cronSession = prepareSession();
      const firstModel = priced ? "first" : "unpriced";
      runEmbeddedAgentMock
        .mockResolvedValueOnce(
          agentResult(interimText, {
            provider: "cron-usage-test",
            model: firstModel,
            contextTokens: 2000,
            usage: { input: 10, output: 20 },
            diagnosticUsage: { input: 100, output: 200, cost: { total: 0.005 } },
            lastCallUsage: { input: 8, output: 2 },
          }),
        )
        .mockResolvedValueOnce(
          agentResult(finalText, {
            provider: "cron-usage-test",
            model: "final",
            contextTokens: 4000,
            usage: { input: 30, output: 40 },
            diagnosticUsage: { input: 1000, output: 2000, cost: { total: 0.01 } },
            lastCallUsage: { input: 25, output: 5 },
          }),
        );
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

  it("delivers only the final result after an earlier silent acknowledgement", async () => {
    const text = "Critical deployment failure: database unavailable.";
    const { resolveCronPayloadOutcome } =
      await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
    resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "123",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      ...agentResult(text, undefined, { finalAssistantVisibleText: text }),
      payloads: [{ text: "NO_REPLY" }, { text }],
    });
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());
    expect(result.status).toBe("ok");
    expect(result.delivered).toBe(true);
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(mockFirstObjectArg(dispatchCronDeliveryMock)).toMatchObject({
      skipDelivery: undefined,
      deliveryPayloads: [{ text }],
    });
  });

  it("does not retry over a fatal structured failure signal", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce(
      agentResult("On it, retrying now.", undefined, { failureSignal: denied }),
    );
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());
    expect(result.status).toBe("error");
    expect(result.error).toBe("SYSTEM_RUN_DENIED: approval required");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });

  it("delivers synthesized fatal failure signals even when the original payloads are empty", async () => {
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "123",
    });
    runEmbeddedAgentMock.mockResolvedValueOnce(
      agentResult(undefined, undefined, { failureSignal: denied }),
    );
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());
    expect(result.status).toBe("error");
    expect(result.error).toBe("SYSTEM_RUN_DENIED: approval required");
    const deliveryRequest = mockFirstObjectArg(dispatchCronDeliveryMock);
    expect(deliveryRequest.skipDelivery).toBeUndefined();
    expect(deliveryRequest.deliveryPayloads).toEqual([
      { text: "SYSTEM_RUN_DENIED: approval required", isError: true },
    ]);
  });

  it("does not retry when descendants were spawned in this run even if they already settled", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce(
      agentResult("On it, I spawned a subagent and it will auto-announce when done."),
    );
    readDescendantExecutionStateMock.mockResolvedValue({
      hasFreshDescendants: true,
      hasActiveDescendants: false,
    });
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());
    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const { runStartedAt } = mockFirstObjectArg(dispatchCronDeliveryMock);
    expect(runStartedAt).toEqual(expect.any(Number));
    expect(readDescendantExecutionStateMock).toHaveBeenCalledWith(
      "agent:default:cron:test:run:test-session-id",
      runStartedAt,
    );
  });

  it("does not restart a prompt after cancellation during descendant observation", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce(agentResult("On it, gathering the results."));
    const entered = createDeferredCore();
    const release = createDeferredCore();
    readDescendantExecutionStateMock.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { hasFreshDescendants: false, hasActiveDescendants: false };
    });
    const controller = new AbortController();
    const pending = runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ abortSignal: controller.signal }),
    );
    void pending.catch(() => {});
    try {
      expect(
        await Promise.race([entered.promise.then(() => "reading"), pending.then(() => "done")]),
      ).toBe("reading");
      controller.abort(new Error("Cron observation canceled"));
      release.resolve();
      expect(await pending).toMatchObject({ status: "error" });
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });
});
