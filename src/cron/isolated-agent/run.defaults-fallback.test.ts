import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveAgentModelFallbacksOverrideMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — agents.defaults.model.fallbacks (#46600)", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("applies agents.defaults.model.fallbacks when no per-agent or payload fallbacks exist", async () => {
    // No per-agent fallbacks (returns undefined, simulating no agents.list entry)
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "openrouter/minimax/minimax-m2.5",
                fallbacks: ["openrouter/minimax/minimax-m2.1"],
              },
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "run digest" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0][0].fallbacksOverride).toEqual([
      "openrouter/minimax/minimax-m2.1",
    ]);
  });

  it("applies agents.defaults.model.fallbacks with multiple fallback entries", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
                fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.2"],
              },
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "run digest" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0][0].fallbacksOverride).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.2",
    ]);
  });

  it("does not set fallbacksOverride when no fallbacks are configured anywhere", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "openrouter/minimax/minimax-m2.5",
              },
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "run digest" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    // When no fallbacks are configured, fallbacksOverride should be undefined
    // so runWithModelFallback can use its own default resolution logic.
    expect(runWithModelFallbackMock.mock.calls[0][0].fallbacksOverride).toBeUndefined();
  });

  it("prefers per-agent fallbacks over defaults.model.fallbacks", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["openai/gpt-5.4"]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "openrouter/minimax/minimax-m2.5",
                fallbacks: ["openrouter/minimax/minimax-m2.1"],
              },
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "run digest" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0][0].fallbacksOverride).toEqual(["openai/gpt-5.4"]);
  });

  it("prefers payload.fallbacks over both per-agent and defaults.model.fallbacks", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["openai/gpt-5.4"]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "openrouter/minimax/minimax-m2.5",
                fallbacks: ["openrouter/minimax/minimax-m2.1"],
              },
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "run digest",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0][0].fallbacksOverride).toEqual([
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("does not set fallbacksOverride when model config is a plain string", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              model: "openrouter/minimax/minimax-m2.5",
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "run digest" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    // String model config has no fallbacks, so fallbacksOverride should be undefined
    expect(runWithModelFallbackMock.mock.calls[0][0].fallbacksOverride).toBeUndefined();
  });
});
