import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveAgentModelFallbacksOverrideMock,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makePayloadJob(overrides?: Record<string, unknown>) {
  return {
    id: "test-job",
    name: "Test Job",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "test" },
    ...overrides,
  } as never;
}

function makePayloadParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makePayloadJob(overrides?.job as Record<string, unknown> | undefined),
    message: "test",
    sessionKey: "cron:test",
    ...overrides,
  };
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — payload.fallbacks", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronSessionMock.mockReturnValue(makeCronSession());
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it.each([
    {
      name: "passes payload.fallbacks as fallbacksOverride when defined",
      payload: {
        kind: "agentTurn",
        message: "test",
        fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5"],
      },
      expectedFallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5"],
    },
    {
      name: "falls back to agent-level fallbacks when payload.fallbacks is undefined",
      payload: { kind: "agentTurn", message: "test" },
      agentFallbacks: ["openai/gpt-4o"],
      expectedFallbacks: ["openai/gpt-4o"],
    },
    {
      name: "payload.fallbacks=[] disables fallbacks even when agent config has them",
      payload: { kind: "agentTurn", message: "test", fallbacks: [] },
      agentFallbacks: ["openai/gpt-4o"],
      expectedFallbacks: [],
    },
  ])("$name", async ({ payload, agentFallbacks, expectedFallbacks }) => {
    if (agentFallbacks) {
      resolveAgentModelFallbacksOverrideMock.mockReturnValue(agentFallbacks);
    }

    const result = await runCronIsolatedAgentTurn(
      makePayloadParams({
        job: makePayloadJob({ payload }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0][0].fallbacksOverride).toEqual(expectedFallbacks);
  });
});
