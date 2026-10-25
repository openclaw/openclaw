import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { ReplyPayload } from "../reply-payload.js";
import {
  rootDir,
  runCliAgentMock,
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";
import { createReplyReasoningVisibility, isReplyReasoningVisible } from "./reasoning-visibility.js";

await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});

await import("./agent-runner-run.js");

setupAgentRunnerTestHooks();

describe("runReplyAgent automatic thinking normalization", () => {
  it.each(["embedded", "cli"] as const)(
    "keeps %s clamp diagnostics out of ordinary channel replies",
    async (runtime) => {
      const runner = runtime === "cli" ? runCliAgentMock : runEmbeddedAgentMock;
      runner.mockResolvedValueOnce({
        payloads: [{ text: "The answer" }],
        meta: { requestShaping: { thinking: "medium" } },
      });
      const base = createBaseRun({
        context: { Provider: "telegram", OriginatingTo: "-100123:topic:42", MessageSid: "123" },
        run: {
          provider: runtime === "cli" ? "claude-cli" : "anthropic",
          model: runtime === "cli" ? "opus-4.5" : "claude",
          messageProvider: "telegram",
          thinkLevel: "adaptive",
        },
      });

      const result = await base.run();

      expect(runner).toHaveBeenCalledOnce();
      const payloads = Array.isArray(result) ? result : result ? [result] : [];
      expect(payloads.map((payload) => payload.text)).toEqual(["The answer"]);
      expect(base.followupRun.run.thinkLevel).toBe("adaptive");
    },
  );
});

it.each([false, true])(
  "binds the executing turn's reasoning visibility (block streaming: %s)",
  async (blockStreamingEnabled) => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now(), reasoningLevel: "on" };
    await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
    const owner = await createReplyReasoningVisibility({
      agentId: "main",
      storePath,
      sessionKey,
      sessionEntry: loadSessionEntry({ storePath, sessionKey }),
      authorized: true,
      resolvedLevel: "on",
    });
    const isVisible = isReplyReasoningVisible;
    const onBlockReply = vi.fn((payload: ReplyPayload) => {
      expect(isVisible(payload)).toBe(true);
    });
    runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
      await params.onBlockReply?.({ text: "Streamed reasoning", isReasoning: true });
      return {
        payloads: [{ text: "Reasoning", isReasoning: true }, { text: "Done" }],
        meta: {},
      };
    });
    try {
      const result = await createBaseRun({
        run: { sessionKey, reasoningLevel: "on", reasoningVisibility: owner },
        reply: {
          sessionKey,
          storePath,
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          blockStreamingEnabled,
          blockReplyChunking: { minChars: 1, maxChars: 200, breakPreference: "paragraph" },
          opts: { onBlockReply, reasoningPayloadsEnabled: true },
        },
      }).run();
      const payloads = Array.isArray(result) ? result : [result];
      const reasoning = expectDefined(
        payloads.find((payload) => payload?.isReasoning),
        "reasoning reply",
      );
      expect(isVisible(reasoning)).toBe(true);
      expect(onBlockReply).toHaveBeenCalledOnce();
      owner.close();
      expect(isVisible(reasoning)).toBe(false);
    } finally {
      owner.close();
    }
  },
);
