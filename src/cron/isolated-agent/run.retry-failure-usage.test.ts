import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { onInternalDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  pickLastNonEmptyTextFromPayloadsMock,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("cron retry failure accounting", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each([
    "failure",
    "cancellation",
    "usage-persist-failure",
    "session-replaced",
    "delivery-failure",
  ] as const)(
    "keeps completed usage once after retry %s without delivering the acknowledgement",
    async (outcome) => {
      const cronSession = makeCronSession();
      const sessionScope = {
        storePath: cronSession.storePath,
        sessionKey: "agent:main:cron:test",
      };
      resolveCronSessionMock.mockReturnValue(cronSession);
      pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
        (payloads: Array<{ text?: string }>) => payloads.at(-1)?.text ?? "",
      );
      resolveCronDeliveryPlanMock.mockReturnValue({
        requested: true,
        mode: "announce",
        channel: "messagechat",
        to: "123",
      });
      const controller = new AbortController();
      const retryCompleted = outcome === "delivery-failure";
      const error =
        outcome === "cancellation"
          ? "cron: job execution timed out"
          : retryCompleted
            ? "delivery failed"
            : "retry failed";
      if (retryCompleted) {
        dispatchCronDeliveryMock.mockRejectedValueOnce(new Error(error));
      }
      runEmbeddedAgentMock
        .mockImplementationOnce(async (request) => {
          request.onExecutionStarted?.();
          return {
            payloads: [{ text: "On it, checking the report now." }],
            meta: {
              agentMeta: {
                provider: "completed-provider",
                model: "completed-model",
                sessionId: "ack-session",
                agentHarnessId: "ack-harness",
                contextTokens: 2000,
                usage: { input: 10, output: 20, cacheRead: 3, cost: { total: 0.01 } },
                diagnosticUsage: { input: 100, output: 200, cost: { total: 0.05 } },
                lastCallUsage: { input: 8, output: 2 },
              },
            },
          };
        })
        .mockImplementationOnce(async () => {
          if (retryCompleted) {
            return {
              payloads: [{ text: "The report is ready." }],
              meta: { agentMeta: { usage: { input: 30, output: 40, cost: { total: 0.02 } } } },
            };
          }
          if (outcome === "cancellation") {
            controller.abort(new Error(error));
          }
          if (outcome === "usage-persist-failure") {
            patchSessionEntryMock.mockImplementationOnce(async () => {
              controller.abort(new Error("late accounting timeout"));
              throw new Error("usage persistence failed");
            });
          }
          if (outcome === "session-replaced") {
            await patchSessionEntryMock(
              sessionScope,
              (entry: SessionEntry) => ({
                ...entry,
                sessionId: "replacement-session",
                lifecycleRevision: "replacement-revision",
                inputTokens: 999,
                estimatedCostUsd: 9,
              }),
              { fallbackEntry: cronSession.sessionEntry },
            );
          }
          throw new Error(error);
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
          makeIsolatedAgentParamsFixture({ agentId: "main", abortSignal: controller.signal }),
        );

        expect(result).toMatchObject({ status: "error", error, executionStarted: true });
        expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
        expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(retryCompleted ? 1 : 0);
        if (retryCompleted) {
          expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
            expect.objectContaining({ deliveryPayloads: [{ text: "The report is ready." }] }),
          );
        }
        expect(result.outputText).toBeUndefined();
        expect(result.usage).toEqual({
          input_tokens: retryCompleted ? 40 : 10,
          output_tokens: retryCompleted ? 60 : 20,
          cache_read_tokens: 3,
          total_tokens: retryCompleted ? 103 : 33,
        });
        expect(cronSession.sessionEntry).toMatchObject({
          inputTokens: retryCompleted ? 40 : 10,
          outputTokens: retryCompleted ? 60 : 20,
          cacheRead: 3,
          cacheWrite: 0,
          estimatedCostUsd: retryCompleted ? 0.03 : 0.01,
        });
        expect(cronSession.sessionEntry.sessionId).toBe("test-session-id");
        expect(cronSession.sessionEntry.agentHarnessId).not.toBe("ack-harness");
        if (outcome === "usage-persist-failure") {
          expect(logWarnMock).toHaveBeenCalledWith(
            expect.stringContaining("usage persistence failed"),
          );
        }
        if (outcome === "session-replaced") {
          expect(await patchSessionEntryMock(sessionScope, () => null)).toMatchObject({
            sessionId: "replacement-session",
            lifecycleRevision: "replacement-revision",
            inputTokens: 999,
            estimatedCostUsd: 9,
          });
          expect(logWarnMock).toHaveBeenCalledWith(
            expect.stringContaining(`Session "${sessionScope.sessionKey}" changed`),
          );
        }
        expect(usageEvents).toMatchObject([
          {
            provider: "completed-provider",
            model: "completed-model",
            usage: { input: 100, output: 200, total: 300 },
            context: { limit: 2000, used: 8 },
            costUsd: 0.05,
          },
          ...(retryCompleted
            ? [{ usage: { input: 30, output: 40, total: 70 }, costUsd: 0.02 }]
            : []),
        ]);
      } finally {
        unsubscribe();
      }
    },
  );
});
