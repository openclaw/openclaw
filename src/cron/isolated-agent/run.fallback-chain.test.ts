// Covers isolated cron model-fallback recovery for result-level empty/incomplete
// returns and for cron wall-clock timeout aborts that must not block later candidates.
import { describe, expect, it } from "vitest";
import { mergeEmbeddedAgentRunResultForModelFallbackExhaustion } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import {
  isCronWallClockTimeoutAbort,
  resolveCronFallbackRunAbortSignal,
} from "../service/execution-errors.js";
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
        const runOptions = {
          isFinalFallbackAttempt: index === candidates.length - 1,
        };
        let result: unknown;
        try {
          result = await run(candidate.provider, candidate.model, runOptions);
        } catch (err) {
          if (index === candidates.length - 1) {
            throw err;
          }
          continue;
        }
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

function makeCronTimeoutAbortController(): AbortController {
  const abortController = new AbortController();
  const timeoutError = new Error("cron: job execution timed out (last phase: model_call_started)");
  timeoutError.name = "TimeoutError";
  abortController.abort(timeoutError);
  return abortController;
}

describe("cron fallback abort signal helpers", () => {
  it("detects cron wall-clock TimeoutError aborts", () => {
    const controller = makeCronTimeoutAbortController();
    expect(isCronWallClockTimeoutAbort(controller.signal)).toBe(true);
  });

  it("drops cron timeout abort for fallback attempts", () => {
    const controller = makeCronTimeoutAbortController();
    expect(
      resolveCronFallbackRunAbortSignal({
        abortSignal: controller.signal,
      }),
    ).toBeUndefined();
  });

  it("keeps operator cancellation aborts for fallback attempts", () => {
    const controller = new AbortController();
    controller.abort("Cancelled by operator.");
    expect(
      resolveCronFallbackRunAbortSignal({
        abortSignal: controller.signal,
      }),
    ).toBe(controller.signal);
  });
});

describe("runCronIsolatedAgentTurn — cron fallback chain recovery", () => {
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

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(result.status).toBe("ok");
  });

  it("engages fallback models after cron wall-clock timeout without passing the dead abort signal", async () => {
    installFaithfulFallbackLoop();
    const abortController = new AbortController();
    runEmbeddedAgentMock.mockReset();
    runEmbeddedAgentMock
      .mockImplementationOnce(async (params) => {
        const timeoutError = new Error(
          "cron: job execution timed out (last phase: model_call_started)",
        );
        timeoutError.name = "TimeoutError";
        abortController.abort(timeoutError);
        expect(params.abortSignal?.aborted).toBe(true);
        const abortErr = new Error("Operation aborted");
        abortErr.name = "AbortError";
        throw abortErr;
      })
      .mockImplementationOnce(async (params) => {
        expect(params.abortSignal?.aborted).not.toBe(true);
        return makeHealthyFallbackResult();
      });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        abortSignal: abortController.signal,
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "test",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        }),
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
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
    expect(
      await request.classifyResult?.({
        result: reasoningOnly,
        provider: "openai",
        model: "gpt-5.4",
        attempt: 1,
        total: 2,
      }),
    ).toBeTruthy();

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
