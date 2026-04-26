import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import { loadRunCronIsolatedAgentTurn, runWithModelFallbackMock } from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — fallback time budget", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("stops new fallback attempts when the outer cron deadline is nearly exhausted", async () => {
    let secondAttemptGate:
      | {
          type: "stop";
          reason?: string | null;
          error?: string;
        }
      | undefined = undefined;

    runWithModelFallbackMock.mockImplementationOnce(async (params) => {
      expect(params.beforeAttempt).toBeTypeOf("function");

      const firstAttemptGate = await params.beforeAttempt?.({
        candidate: { provider: "anthropic", model: "claude-opus-4-6" },
        attempt: 1,
        total: 2,
        previousAttempts: [],
        isPrimary: true,
        requestedModelMatched: true,
        fallbackConfigured: true,
      });
      secondAttemptGate = await params.beforeAttempt?.({
        candidate: { provider: "openai-codex", model: "gpt-5.4" },
        attempt: 2,
        total: 2,
        previousAttempts: [
          {
            provider: "anthropic",
            model: "claude-opus-4-6",
            error: "Request was aborted.",
            reason: "unknown",
          },
        ],
        isPrimary: false,
        requestedModelMatched: false,
        fallbackConfigured: true,
      });

      expect(firstAttemptGate).toBeUndefined();
      return {
        result: {
          payloads: [{ text: "done" }],
          meta: { agentMeta: { usage: { input: 10, output: 20 } } },
        },
        provider: "anthropic",
        model: "claude-opus-4-6",
        attempts: [],
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        deadlineAtMs: Date.now() + 20_000,
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "test", timeoutSeconds: 120 },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(secondAttemptGate).toMatchObject({
      type: "stop",
      reason: "timeout",
      error: expect.stringContaining("need at least 30000ms"),
    });
  });
});
