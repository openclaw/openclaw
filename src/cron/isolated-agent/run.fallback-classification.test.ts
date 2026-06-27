// Regression tests for isolated-cron model fallback result classification (#97115).
//
// The isolated cron runWithModelFallback call must pass the embedded-result
// classifier (and exhaustion merger), matching the live agent turn path. Without
// them, a fallback model that returns a clean stop with no visible reply is
// treated as success and the fallback chain stops, silently breaking cron jobs.
import { describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveAgentModelFallbacksOverrideMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function requireModelFallbackRequest(): {
  classifyResult?: unknown;
  mergeExhaustedResult?: unknown;
} {
  const request = runWithModelFallbackMock.mock.calls[0]?.[0] as
    | {
        classifyResult?: unknown;
        mergeExhaustedResult?: unknown;
      }
    | undefined;
  if (!request) {
    throw new Error("Expected model fallback request");
  }
  return request;
}

describe("runCronIsolatedAgentTurn — fallback result classification (#97115)", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("passes a classifyResult callback into the model fallback request", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["anthropic/claude-sonnet-4-6"]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: { kind: "agentTurn", message: "test" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(typeof requireModelFallbackRequest().classifyResult).toBe("function");
  });

  it("passes a mergeExhaustedResult callback into the model fallback request", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["anthropic/claude-sonnet-4-6"]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: { kind: "agentTurn", message: "test" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(typeof requireModelFallbackRequest().mergeExhaustedResult).toBe("function");
  });

  it("classifies an empty embedded result as a fallback-eligible failure", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["anthropic/claude-sonnet-4-6"]);

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: { kind: "agentTurn", message: "test" },
        }),
      }),
    );

    const { classifyResult } = requireModelFallbackRequest();
    if (typeof classifyResult !== "function") {
      throw new Error("classifyResult was not forwarded to the fallback request");
    }
    // A fallback model that returns a clean stop with zero visible output must be
    // classified as a failure so the chain continues to the next candidate.
    const classification = await (
      classifyResult as (args: {
        provider: string;
        model: string;
        result: unknown;
      }) => Promise<{ code: string; reason: string } | null>
    )({
      provider: "google",
      model: "gemini-3.5-flash",
      result: {
        payloads: [],
        meta: {
          agentHarnessResultClassification: "empty",
          finalAssistantVisibleText: "",
        },
      },
    });

    expect(classification).not.toBeNull();
    expect(classification?.code).toBe("empty_result");
  });
});
