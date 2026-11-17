import { expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { nonReasoningModelState } from "./get-reply-run.test-support.js";

export function registerPreparedReplyThinkingCases(
  runPrepared: (
    overrides: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>,
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0],
  runReplyAgentMock: typeof runReplyAgent,
) {
  it.each(["explicit", "stored"] as const)(
    "validates %s thinking while preserving the stored preference",
    async (source) => {
      const sessionEntry: SessionEntry = {
        sessionId: "session-thinking",
        sessionFile: "/tmp/session-thinking.jsonl",
        thinkingLevel: "high",
        updatedAt: 1,
      };
      const sessionStore = { "session-key": sessionEntry };
      const result = await runPrepared({
        provider: "openai",
        model: "chat-latest",
        modelState: nonReasoningModelState(),
        ...(source === "explicit"
          ? { resolvedThinkLevel: "xhigh", opts: { thinkingLevelOverride: "xhigh" } }
          : {
              resolvedThinkLevel: "high",
              sessionEntry,
              sessionStore,
              storePath: "/tmp/openclaw-sessions.json",
            }),
      });
      if (source === "explicit") {
        expect(Array.isArray(result) ? undefined : result?.text).toContain(
          'Thinking level "xhigh" is not supported',
        );
        expect(runReplyAgentMock).not.toHaveBeenCalled();
      } else {
        expect(requireRunReplyAgentCall().followupRun.run.thinkLevel).toBe("high");
        expect(sessionEntry.thinkingLevel).toBe("high");
        expect(sessionStore["session-key"]?.thinkingLevel).toBe("high");
      }
    },
  );

  it.each([
    ["off", "low"],
    ["low", "low"],
    ["high", "high"],
  ] as const)(
    "resolves Talk preference %s against the selected consult model",
    async (requested, expected) => {
      const catalog = [
        {
          provider: "anthropic",
          id: "synthetic-thinking-model",
          name: "Synthetic thinking model",
          reasoning: true,
          thinkingLevelMap: { off: null, minimal: null },
          compat: { thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "medium" },
        },
      ];
      await runPrepared({
        provider: "anthropic",
        model: "synthetic-thinking-model",
        modelState: {
          ...nonReasoningModelState(),
          allowedModelCatalog: catalog,
          resolveThinkingCatalog: async () => catalog,
        },
        resolvedThinkLevel: requested,
        opts: { thinkingLevelOverride: requested, normalizeThinkingLevelOverride: true },
      });
      const run = requireRunReplyAgentCall().followupRun.run;
      expect(run.thinkLevel).toBe(expected);
      expect(run.thinkLevelOverride).toBe(requested);
    },
  );

  it("does not clamp inherited thinking without a Talk override", async () => {
    await runPrepared({
      provider: "openai",
      model: "chat-latest",
      modelState: nonReasoningModelState(),
      resolvedThinkLevel: "high",
      opts: { normalizeThinkingLevelOverride: true },
    });
    const run = requireRunReplyAgentCall().followupRun.run;
    expect(run.thinkLevel).toBe("high");
    expect(run.thinkLevelOverride).toBeUndefined();
  });
}
