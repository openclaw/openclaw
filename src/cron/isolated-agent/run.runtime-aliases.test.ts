import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  runCliAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// Regression test for cron lane parity with the mention/Slack lane: when the
// fallback wrapper invokes the run callback with a canonical provider id (e.g.
// "anthropic") but `agents.defaults.agentRuntime.id` selects a CLI runtime
// (e.g. "claude-cli"), the cron executor must rewrite the execution provider
// before calling runCliAgent. Without the rewrite, runCliAgent receives the
// raw provider id and the CLI runtime never executes.
describe("runCronIsolatedAgentTurn — cli runtime alias rewrite", () => {
  setupRunCronIsolatedAgentTurnSuite();

  function mockFallbackInvocationWithProvider(provider: string, model: string) {
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        const result = await params.run(provider, model);
        return { result, provider, model, attempts: [] };
      },
    );
  }

  it("rewrites canonical provider to CLI runtime when agents.defaults.agentRuntime selects claude-cli", async () => {
    isCliProviderMock.mockReturnValue(true);
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "output" }],
      meta: { agentMeta: { sessionId: "test-session", usage: { input: 5, output: 10 } } },
    });
    mockFallbackInvocationWithProvider("anthropic", "claude-opus-4-6");

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: { agentRuntime: { id: "claude-cli" } },
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(runCliAgentMock.mock.calls[0][0]).toHaveProperty("provider", "claude-cli");
  });

  it("rewrites per-agent runtime override over canonical provider", async () => {
    isCliProviderMock.mockReturnValue(true);
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "output" }],
      meta: { agentMeta: { sessionId: "test-session", usage: { input: 5, output: 10 } } },
    });
    mockFallbackInvocationWithProvider("anthropic", "claude-opus-4-6");

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            list: [{ id: "scout", agentRuntime: { id: "claude-cli" } }],
          },
        },
        agentId: "scout",
      }),
    );

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(runCliAgentMock.mock.calls[0][0]).toHaveProperty("provider", "claude-cli");
  });
});
