import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn as persistTurn,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  appendAssistantMessageToSessionTranscript as mirrorReply,
  readRecentUserAssistantTextForSession as readRecent,
} from "../../config/sessions/transcript.js";
import { persistUserTurnTranscript } from "../../sessions/user-turn-transcript.persistence.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { runPreparedChannelTurn } from "../turn/execution.js";
import { mergeSessionTranscriptContext } from "./session-transcript-context.runtime.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "source-reply-context-");
const chatWindow = (source: string, messages: object[]) => [
  { label: "Conversation context", source, type: "chat_window", payload: { messages } },
];

it.each([false, true])(
  "reconciles completed replies and recent requests (aborted: %s)",
  async (aborted) => {
    const scope = {
      agentId: "main",
      sessionId: "conversation",
      sessionKey: "agent:main:main",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
    const sessionEntry = { sessionId: scope.sessionId, chatType: "channel" as const, updatedAt: 1 };
    await replaceSessionEntry(scope, sessionEntry);
    const append = (...messages: unknown[]) =>
      persistTurn(scope, {
        updateMode: "none",
        messages: messages.map((message) => ({ message })),
      });
    const user = (text: string, messageId: string) =>
      persistUserTurnTranscript({
        ...scope,
        sessionEntry,
        input: { text, timestamp: Date.now(), transport: { channel: "discord", messageId } },
      });
    const ctx: FinalizedMsgContext = {
      Body: "What do you think of it?",
      SessionKey: scope.sessionKey,
      AgentId: scope.agentId,
      Provider: "telegram",
      CommandAuthorized: false,
      SessionTranscriptContext: {
        chatWindow: true,
        historyLimit: 4,
        senderLabels: { assistant: "OpenClaw", user: "User" },
      },
    };
    const render = async () => {
      let prompt = "";
      await runPreparedChannelTurn({
        channel: ctx.Provider!,
        routeSessionKey: scope.sessionKey,
        storePath: scope.storePath,
        ctxPayload: ctx,
        recordInboundSession: async () => undefined,
        runDispatch: async () => {
          prompt = buildInboundUserContextPrefix(ctx);
          return { queuedFinal: false };
        },
      });
      return prompt;
    };
    const exchanges = [
      ["How was the task performed?", "Done: the task used the local tool."],
      ["Send the summary.", "Done: here is the summary."],
    ] as const;
    for (const [index, [question, answer]] of exchanges.entries()) {
      const toolCallId = `send-${index}`;
      await user(question, toolCallId);
      await append({
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "message",
            arguments: { action: "send", message: answer, final: true },
          },
        ],
      });
      const deliveryMirror = {
        kind: "message-tool-source-reply" as const,
        final: true,
        sourceTurnId: `source-turn-${index}`,
        toolCallId,
      };
      expect((await mirrorReply({ ...scope, text: answer, deliveryMirror })).ok).toBe(true);
      await append({
        role: "toolResult",
        toolName: "message",
        toolCallId,
        isError: aborted,
        content: [{ type: "text", text: aborted ? "aborted by user" : '{"ok":true}' }],
      });
    }
    const stored = await loadTranscriptEvents(scope);
    ctx.Timestamp = Date.now() + 1_000;
    const prompt = await render();
    const expectedMessages = exchanges.flatMap(([question, answer]) => [
      { sender: "User", body: question },
      { sender: "OpenClaw", body: answer },
    ]);
    expect(ctx.ChannelStructuredContext).toMatchObject(chatWindow("session", expectedMessages));
    for (const text of exchanges.flat()) {
      expect(prompt.split(text)).toHaveLength(2);
    }
    ctx.ChannelStructuredContext = chatWindow("telegram", [
      {
        message_id: "native-answer",
        sender: "OpenClaw (you)",
        timestamp_ms: 1_000,
        body: exchanges[0][1],
      },
    ]);
    await mergeSessionTranscriptContext({ ...scope, ctx });
    expect(buildInboundUserContextPrefix(ctx).split(exchanges[0][1])).toHaveLength(2);
    expect(await loadTranscriptEvents(scope)).toEqual(stored);

    const mirrorOrigin = "codex-app-server";
    const incomplete = [
      [
        "commentary",
        {
          stopReason: "stop",
          openclawStreamFallback: {
            replacementText: "Checking",
            source: "segment",
            itemId: "item",
          },
          __openclaw: { mirrorOrigin, runId: "commentary-run" },
        },
      ],
      ["failed", { stopReason: "error", errorMessage: "provider failed" }],
      ["interrupted", { stopReason: "aborted" }],
      ["truncated", { stopReason: "length" }],
      ["tool-progress", { stopReason: "toolUse" }],
      ["phased-commentary", { stopReason: "stop", phase: "commentary" }],
      ["unsettled-native", { stopReason: "stop", __openclaw: { mirrorOrigin } }],
    ] as const;
    for (const [id, message] of incomplete) {
      await user(`request ${id}`, id);
      await append({ role: "assistant", content: "Checking", ...message });
    }
    await user("request no-output", "no-output");
    await user("request completed", "completed");
    await append({
      role: "assistant",
      content: "Done",
      stopReason: "stop",
      __openclaw: { mirrorOrigin, runTerminal: true },
    });
    ctx.Provider = "discord";
    ctx.ChannelStructuredContext = [];
    ctx.SessionTranscriptContext = { historyLimit: 20, historyKind: "recent" };
    ctx.InboundHistory = [
      { messageId: "send-0", sender: "Alice", body: exchanges[0][0] },
      { messageId: "send-1", sender: "Alice", body: exchanges[1][0] + " edited" },
      { messageId: "completed", sender: "Alice", body: "request completed" },
      { messageId: "no-output", sender: "Alice", body: "request no-output" },
      { messageId: "unseen", sender: "Bob", body: "unseen side discussion" },
      ...incomplete.map(([id]) => ({ messageId: id, sender: "Alice", body: `request ${id}` })),
    ];
    const recentPrompt = await render();
    const retained = ["send-1", "no-output", "unseen", ...incomplete.map(([id]) => id)];
    expect(ctx.InboundHistory.map((entry) => entry.messageId)).toEqual(retained);
    expect(recentPrompt).toContain(`"history_count":${retained.length}`);
    for (const { body } of ctx.InboundHistory) {
      expect(recentPrompt).toContain(body);
    }
    expect(recentPrompt).not.toContain(exchanges[0][0]);
    expect(recentPrompt).not.toContain("request completed");
    for (const turn of await readRecent(scope)) {
      expect(turn).not.toHaveProperty("messageId");
      expect(turn).not.toHaveProperty("isCompletedAnswer");
    }
  },
);
