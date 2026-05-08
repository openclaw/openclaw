import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  preflightCronModelProviderMock,
  resolveAgentModelFallbacksOverrideMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — model preflight fallback", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("skips the run when primary is unavailable and no fallbacks are configured", async () => {
    preflightCronModelProviderMock.mockResolvedValue({
      status: "unavailable",
      reason: "Local Ollama endpoint unreachable at http://localhost:11434",
      provider: "ollama",
      model: "llama3",
      baseUrl: "http://localhost:11434",
      retryAfterMs: 300000,
    });
    // default: resolveAgentModelFallbacksOverrideMock returns undefined → no fallbacks

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload: { kind: "agentTurn", message: "hello" } }),
      }),
    );

    expect(result.status).toBe("skipped");
    expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(1);
  });

  it("uses the first available fallback when primary is unavailable", async () => {
    preflightCronModelProviderMock
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "Local Ollama endpoint unreachable at http://localhost:11434",
        provider: "ollama",
        model: "llama3",
        baseUrl: "http://localhost:11434",
        retryAfterMs: 300000,
      })
      .mockResolvedValue({ status: "available" });

    resolveAgentModelFallbacksOverrideMock.mockReturnValue([
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5.4",
    ]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload: { kind: "agentTurn", message: "hello" } }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(2);
    expect(preflightCronModelProviderMock.mock.calls[1][0]).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("using fallback anthropic/claude-haiku-4-5"),
    );
  });

  it("skips to the second fallback when the first is also unavailable", async () => {
    preflightCronModelProviderMock
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "primary unreachable",
        provider: "ollama",
        model: "llama3",
        baseUrl: "http://localhost:11434",
        retryAfterMs: 300000,
      })
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "first fallback unreachable",
        provider: "vllm",
        model: "mistral",
        baseUrl: "http://localhost:8000",
        retryAfterMs: 300000,
      })
      .mockResolvedValue({ status: "available" });

    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["vllm/mistral", "openai/gpt-5.4"]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload: { kind: "agentTurn", message: "hello" } }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(3);
    expect(preflightCronModelProviderMock.mock.calls[2][0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  it("skips the run when primary and all fallbacks are unavailable", async () => {
    preflightCronModelProviderMock.mockResolvedValue({
      status: "unavailable",
      reason: "all endpoints down",
      provider: "ollama",
      model: "llama3",
      baseUrl: "http://localhost:11434",
      retryAfterMs: 300000,
    });

    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["vllm/mistral", "lmstudio/phi-4"]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload: { kind: "agentTurn", message: "hello" } }),
      }),
    );

    expect(result.status).toBe("skipped");
    expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(3);
  });

  it("does not probe fallbacks when primary is available", async () => {
    preflightCronModelProviderMock.mockResolvedValue({ status: "available" });
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["openai/gpt-5.4"]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload: { kind: "agentTurn", message: "hello" } }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(1);
  });
});
