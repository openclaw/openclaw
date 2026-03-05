import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveAgentModelFallbacksOverrideMock,
  resolveCronSessionMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — payload.fallbacks", () => {
  setupRunCronIsolatedAgentTurnSuite();

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
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0][0].fallbacksOverride).toEqual(expectedFallbacks);
  });

  it("passes the per-run cron session key to runEmbeddedPiAgent", async () => {
    const sessionId = "run-session-key-regression";
    resolveCronSessionMock.mockReturnValue({
      storePath: "/tmp/store.json",
      store: {},
      sessionEntry: {
        sessionId,
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
      },
      systemSent: false,
      isNewSession: true,
    });

    runWithModelFallbackMock.mockImplementationOnce(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        const result = await params.run("openai", "gpt-4");
        return {
          result,
          provider: "openai",
          model: "gpt-4",
        };
      },
    );

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `agent:default:cron:test:run:${sessionId}`,
    });
  });
});
