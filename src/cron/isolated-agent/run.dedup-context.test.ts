import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

/**
 * Intercept the prompt that runCronIsolatedAgentTurn assembles and passes
 * through the real code path: runWithModelFallback → runEmbeddedPiAgent.
 */
function interceptPrompt(): { get(): string } {
  let captured = "";
  runWithModelFallbackMock.mockImplementationOnce(async (opts: { run: Function }) => {
    await opts.run("openai", "gpt-4", {});
    return {
      result: {
        payloads: [{ text: "test output" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
    };
  });
  runEmbeddedPiAgentMock.mockImplementationOnce(async (opts: { prompt: string }) => {
    captured = opts.prompt;
    return {
      payloads: [{ text: "test output" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    };
  });
  return { get: () => captured };
}

describe("runCronIsolatedAgentTurn — dedup context injection", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("includes dedup context block when dedupContext is enabled and outputs exist", async () => {
    const prompt = interceptPrompt();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "Send daily briefing", dedupContext: true },
          state: {
            recentOutputs: [
              { text: "Yesterday's briefing: Stock market rose 2%", timestamp: 1710230400000 },
              { text: "Markets closed flat today", timestamp: 1710316800000 },
            ],
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(prompt.get()).toContain(
      "[Your previous outputs for this scheduled task — avoid repeating the same content:]",
    );
    expect(prompt.get()).toContain("Yesterday's briefing: Stock market rose 2%");
    expect(prompt.get()).toContain("Markets closed flat today");
  });

  it("does not include dedup block when dedupContext is disabled", async () => {
    const prompt = interceptPrompt();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "Send daily briefing" },
          state: {
            recentOutputs: [{ text: "Old output", timestamp: 1710230400000 }],
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(prompt.get()).not.toContain("[Your previous outputs for this scheduled task");
  });

  it("does not include dedup block on first run (no previous outputs)", async () => {
    const prompt = interceptPrompt();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "Send daily briefing", dedupContext: true },
          state: {},
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(prompt.get()).not.toContain("[Your previous outputs for this scheduled task");
  });
});
