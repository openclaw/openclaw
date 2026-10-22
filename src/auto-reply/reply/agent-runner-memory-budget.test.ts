import { expect, it, vi } from "vitest";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
import { runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";

// mock-isolation: Existing transcript usage is fixed; no provider executes before the trigger.
vi.mock("./agent-runner-memory-transcript-context.js", () => ({
  estimatePromptTokensFromSessionTranscript: async () => ({ promptTokens: 150_000 }),
  readSessionLogSnapshot: async () => ({}),
}));

it.each([undefined, 100_000])(
  "uses accepted capacity and authored cap %s at compaction admission",
  async (cap) => {
    const provider = "fixture-maintenance";
    const model = "maintenance-model";
    const followupRun = createTestFollowupRun({
      provider,
      model,
      sessionId: "session",
      sessionKey: "main",
      thinkingCatalog: [
        {
          provider,
          id: model,
          contextWindow: 128_000,
          contextWindowSource: "synthetic",
          contextTokens: 872_000,
        },
      ],
    });
    const triggered = new Error("compaction trigger reached");
    const onCompactionStart = vi.fn(() => {
      throw triggered;
    });
    const pending = runSessionCompactionIfNeeded({
      cfg: cap
        ? {
            models: {
              providers: {
                [provider]: {
                  baseUrl: "https://fixture.example.test/v1",
                  models: [
                    {
                      id: model,
                      name: model,
                      contextTokens: cap,
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      maxTokens: 16384,
                    },
                  ],
                },
              },
            },
          }
        : {},
      followupRun,
      defaultModel: model,

      sessionKey: "main",
      sessionEntry: {
        sessionId: "session",
        updatedAt: 0,
        totalTokens: 150_000,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      },
      onCompactionStart,
    });
    if (cap === undefined) {
      await expect(pending).resolves.toMatchObject({ sessionId: "session" });
      expect(onCompactionStart).not.toHaveBeenCalled();
    } else {
      await expect(pending).rejects.toBe(triggered);
      expect(onCompactionStart).toHaveBeenCalledOnce();
    }
  },
);
