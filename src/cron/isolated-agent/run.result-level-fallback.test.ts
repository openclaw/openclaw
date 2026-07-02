// Regression tests for cron isolated runs engaging model fallback on result-level failures (#96525).
import { createContractRunResult } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it } from "vitest";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function requireModelFallbackRequest(): {
  classifyResult?: (params: { provider: string; model: string; result: unknown }) => unknown;
  mergeExhaustedResult?: unknown;
  fallbacksOverride?: string[];
  provider?: string;
  model?: string;
  run?: (
    provider: string,
    model: string,
    options?: { isFinalFallbackAttempt?: boolean },
  ) => Promise<unknown>;
} {
  const request = runWithModelFallbackMock.mock.calls[0]?.[0];
  if (!request) {
    throw new Error("Expected model fallback request");
  }
  return request;
}

describe("runCronIsolatedAgentTurn — result-level model fallback (#96525)", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("passes embedded result classifiers into runWithModelFallback", async () => {
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "test",
            fallbacks: ["openai/gpt-5.4"],
          },
        }),
      }),
    );

    const request = requireModelFallbackRequest();
    expect(typeof request.classifyResult).toBe("function");
    expect(typeof request.mergeExhaustedResult).toBe("function");
  });

  it("advances to configured fallback when the primary embedded run is reasoning-only", async () => {
    const primary = createContractRunResult({
      meta: {
        durationMs: 1,
        agentHarnessResultClassification: "reasoning-only",
      },
    });
    const fallback = createContractRunResult({
      payloads: [{ text: "cron fallback ok" }],
      meta: { durationMs: 1, finalAssistantVisibleText: "cron fallback ok" },
    });

    runWithModelFallbackMock.mockImplementation(async (params) => {
      const first = await params.run(params.provider, params.model);
      const classification = await params.classifyResult?.({
        provider: params.provider,
        model: params.model,
        result: first,
      });
      expect(classification).toMatchObject({
        reason: "format",
        code: "reasoning_only_result",
      });

      const [fallbackRef] = params.fallbacksOverride ?? [];
      if (!fallbackRef || !classification) {
        return { result: first, provider: params.provider, model: params.model, attempts: [] };
      }
      const slash = fallbackRef.indexOf("/");
      const fallbackProvider = fallbackRef.slice(0, slash);
      const fallbackModel = fallbackRef.slice(slash + 1);
      const second = await params.run(fallbackProvider, fallbackModel, {
        isFinalFallbackAttempt: true,
      });
      return {
        result: second,
        provider: fallbackProvider,
        model: fallbackModel,
        attempts: [
          {
            provider: params.provider,
            model: params.model,
            reason: classification.reason,
            code: classification.code,
          },
        ],
      };
    });

    runEmbeddedAgentMock.mockResolvedValueOnce(primary).mockResolvedValueOnce(fallback);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "test",
            fallbacks: ["openai/gpt-5.4"],
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "anthropic",
        model: "claude-opus-4-6",
        result: primary,
      }),
    ).toMatchObject({ code: "reasoning_only_result" });
  });
});
