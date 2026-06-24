// Covers the cron embedded-run path wiring the embedded result classifier and
// merge helper into runWithModelFallback, so returned result-level failures
// (reasoning-only / empty-visible / incomplete_turn) engage the configured
// fallback chain instead of silently dropping the answer.
import { describe, expect, it } from "vitest";
import { mergeEmbeddedAgentRunResultForModelFallbackExhaustion } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

/** Fallback-safe result-level failure: reasoning-only / incomplete_turn, no visible reply. */
function makeReasoningOnlyIncompleteResult() {
  return {
    payloads: [{ text: "Agent couldn't generate a response.", isError: true }],
    meta: {
      agentMeta: {},
      agentHarnessResultClassification: "reasoning-only",
      error: {
        kind: "incomplete_turn",
        message: "Agent couldn't generate a response.",
        fallbackSafe: true,
        terminalPresentation: false,
      },
    },
  };
}

function makeHealthyFallbackResult() {
  return {
    payloads: [{ text: "Workspace cleaned up: removed 12 stale files." }],
    meta: {
      agentMeta: {},
      finalAssistantVisibleText: "Workspace cleaned up: removed 12 stale files.",
    },
  };
}

/**
 * Minimal faithful model-fallback loop that drives the real classifier/merge the
 * cron path passes, advancing candidates exactly when a classification is returned.
 */
function installFaithfulFallbackLoop(): void {
  runWithModelFallbackMock.mockImplementation(
    async ({ provider, model, run, fallbacksOverride, classifyResult, mergeExhaustedResult }) => {
      const candidates = [
        { provider, model },
        ...((fallbacksOverride ?? []) as string[]).map((ref) => {
          const slash = ref.indexOf("/");
          return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
        }),
      ];
      let latest = { result: undefined as unknown, provider, model };
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const result = await run(candidate.provider, candidate.model, {
          isFinalFallbackAttempt: index === candidates.length - 1,
        });
        const classification = await classifyResult?.({
          result,
          provider: candidate.provider,
          model: candidate.model,
          attempt: index + 1,
          total: candidates.length,
        });
        if (!classification) {
          return { result, provider: candidate.provider, model: candidate.model, attempts: [] };
        }
        latest = { result, provider: candidate.provider, model: candidate.model };
      }
      const merged = mergeExhaustedResult
        ? mergeExhaustedResult({ latestResult: latest.result, preferredResult: latest.result })
        : latest.result;
      return { result: merged, provider: latest.provider, model: latest.model, attempts: [] };
    },
  );
}

describe("runCronIsolatedAgentTurn — result-level fallback wiring", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("engages the configured fallback when the primary returns a reasoning-only / incomplete_turn result", async () => {
    installFaithfulFallbackLoop();
    runEmbeddedAgentMock.mockReset();
    runEmbeddedAgentMock
      .mockResolvedValueOnce(makeReasoningOnlyIncompleteResult())
      .mockResolvedValueOnce(makeHealthyFallbackResult());

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "test",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        }),
      }),
    );

    // Without the classifier wiring the loop would stop on the first reasoning-only
    // result and record a cron error; the fallback model must be reached instead.
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(result.status).toBe("ok");
  });

  it("passes the embedded classifier and merge helper scoped to the embedded branch", async () => {
    mockRunCronFallbackPassthrough();

    await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    const request = runWithModelFallbackMock.mock.calls[0]?.[0] as {
      classifyResult?: (input: {
        result: unknown;
        provider: string;
        model: string;
        attempt: number;
        total: number;
      }) => unknown;
      mergeExhaustedResult?: unknown;
    };
    expect(typeof request?.classifyResult).toBe("function");
    expect(request?.mergeExhaustedResult).toBe(
      mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
    );

    const reasoningOnly = makeReasoningOnlyIncompleteResult();
    // Embedded provider: the result-level failure is classified so the loop advances.
    expect(
      await request.classifyResult?.({
        result: reasoningOnly,
        provider: "openai",
        model: "gpt-5.4",
        attempt: 1,
        total: 2,
      }),
    ).toBeTruthy();

    // CLI providers own their own terminal classification and must be skipped here.
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    expect(
      await request.classifyResult?.({
        result: reasoningOnly,
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        attempt: 1,
        total: 2,
      }),
    ).toBeNull();
  });
});
