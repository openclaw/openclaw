import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn as persistTurn,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript as mirrorReply } from "../../config/sessions/transcript.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { runPreparedChannelTurn } from "../turn/execution.js";
import { mergeSessionTranscriptContext } from "./session-transcript-context.runtime.js";

function chatWindow(source: string, messages: object[]) {
  return [{ label: "Conversation context", source, type: "chat_window", payload: { messages } }];
}

const sessionDirs = useSessionStoreTempDirs(afterAll, "source-reply-context-");

it.each([false, true])(
  "restores SQLite close-outs beside questions (aborted: %s)",
  async (aborted) => {
    const scope = {
      agentId: "main",
      sessionId: "telegram-conversation",
      sessionKey: "agent:main:main",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
    await replaceSessionEntry(scope, {
      sessionId: scope.sessionId,
      chatType: "direct",
      updatedAt: 1,
    });
    const append = (...messages: unknown[]) =>
      persistTurn(scope, {
        updateMode: "none",
        messages: messages.map((message) => ({ message })),
      });
    const exchanges = [
      ["How was the task performed?", "Done: the task used the local tool."],
      ["Send the summary.", "Done: here is the summary."],
    ] as const;
    for (const [index, [question, answer]] of exchanges.entries()) {
      const toolCallId = `send-${index}`;
      const toolCall = {
        type: "toolCall",
        id: toolCallId,
        name: "message",
        arguments: { action: "send", message: answer, final: true },
      };
      await append(
        { role: "user", content: question, timestamp: Date.now() },
        { role: "assistant", content: [toolCall], stopReason: "toolUse" },
      );
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
    const ctx: FinalizedMsgContext = {
      Body: "What do you think of it?",
      SessionKey: scope.sessionKey,
      AgentId: scope.agentId,
      Provider: "telegram",
      Timestamp: Date.now() + 1_000,
      CommandAuthorized: false,
      SessionTranscriptContext: {
        chatWindow: true,
        historyLimit: 4,
        senderLabels: { assistant: "OpenClaw", user: "User" },
      },
    };
    let prompt = "";
    await runPreparedChannelTurn({
      channel: "telegram",
      routeSessionKey: scope.sessionKey,
      storePath: scope.storePath,
      ctxPayload: ctx,
      recordInboundSession: async () => undefined,
      runDispatch: async () => {
        prompt = buildInboundUserContextPrefix(ctx);
        return { queuedFinal: false };
      },
    });

    const expectedMessages = exchanges.flatMap(([question, answer]) => [
      { sender: "User", body: question },
      { sender: "OpenClaw", body: answer },
    ]);
    expect(ctx.ChannelStructuredContext).toMatchObject(chatWindow("session", expectedMessages));
    for (const text of exchanges.flat()) {
      expect(prompt.split(text)).toHaveLength(2);
    }

    // Native windows own delivered replies even with different platform timestamps.
    ctx.ChannelStructuredContext = chatWindow("telegram", [
      {
        message_id: "native-answer",
        sender: "OpenClaw (you)",
        timestamp_ms: 1_000,
        body: "Done: the task used the local tool.",
      },
    ]);
    await mergeSessionTranscriptContext({ ...scope, ctx });
    expect(
      buildInboundUserContextPrefix(ctx).split("Done: the task used the local tool."),
    ).toHaveLength(2);
    expect(await loadTranscriptEvents(scope)).toEqual(stored);
  },
);
