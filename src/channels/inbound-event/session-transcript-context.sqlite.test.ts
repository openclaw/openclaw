import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { CRON_DIRECT_DELIVERY_CONTEXT_KIND } from "../../shared/transcript-only-openclaw-assistant.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { runPreparedChannelTurn } from "../turn/execution.js";
import { mergeSessionTranscriptContext } from "./session-transcript-context.runtime.js";

describe("session transcript channel context over SQLite", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "source-reply-context-");

  it.each([false, true])(
    "keeps delivered close-outs beside their questions on subsequent turns (tool aborted: %s)",
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
      const append = (messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"]) =>
        persistSessionTranscriptTurn(scope, { updateMode: "none", messages });
      const exchanges = [
        ["How was the task performed?", "Done: the task used the local tool."],
        ["Send the summary.", "Done: here is the summary."],
      ] as const;
      for (const [index, [question, answer]] of exchanges.entries()) {
        const toolCallId = `send-${index}`;
        await append([
          { message: { role: "user", content: question, timestamp: Date.now() } },
          {
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: "message",
                  arguments: { action: "send", message: answer, final: true },
                },
              ],
              stopReason: "toolUse",
            },
          },
        ]);
        expect(
          await appendAssistantMessageToSessionTranscript({
            ...scope,
            text: answer,
            deliveryMirror: {
              kind: "message-tool-source-reply",
              final: true,
              sourceTurnId: `source-turn-${index}`,
              toolCallId,
            },
          }),
        ).toMatchObject({ ok: true });
        await append([
          {
            message: {
              role: "toolResult",
              toolName: "message",
              toolCallId,
              isError: aborted,
              content: [{ type: "text", text: aborted ? "aborted by user" : '{"ok":true}' }],
            },
          },
        ]);
      }
      const stored = await loadTranscriptEvents(scope);
      const ctx: FinalizedMsgContext = {
        Body: "What do you think of it?",
        RawBody: "What do you think of it?",
        CommandBody: "What do you think of it?",
        From: "telegram:123",
        To: "telegram:123",
        SessionKey: scope.sessionKey,
        AgentId: scope.agentId,
        Provider: "telegram",
        ChatType: "direct",
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

      expect(ctx.ChannelStructuredContext).toMatchObject([
        {
          source: "session",
          payload: {
            messages: [
              { sender: "User", body: "How was the task performed?" },
              { sender: "OpenClaw", body: "Done: the task used the local tool." },
              { sender: "User", body: "Send the summary." },
              { sender: "OpenClaw", body: "Done: here is the summary." },
            ],
          },
        },
      ]);
      for (const text of exchanges.flat()) {
        expect(prompt.split(text)).toHaveLength(2);
      }

      // Native windows already own their delivered replies, even when their
      // platform timestamp differs from the transcript's delivery timestamp.
      ctx.ChannelStructuredContext = [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          payload: {
            messages: [
              {
                message_id: "native-answer",
                sender: "OpenClaw (you)",
                timestamp_ms: 1_000,
                body: "Done: the task used the local tool.",
              },
            ],
          },
        },
      ];
      await mergeSessionTranscriptContext({ ...scope, ctx });
      expect(
        buildInboundUserContextPrefix(ctx).split("Done: the task used the local tool."),
      ).toHaveLength(2);
      expect(await loadTranscriptEvents(scope)).toEqual(stored);
    },
  );

  it("suppresses already-replayed DM turns while preserving delivery-only context after restart", async () => {
    const scope = {
      agentId: "main",
      sessionId: "telegram-dm-delivery-only",
      sessionKey: "agent:main:main",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
    await replaceSessionEntry(scope, {
      sessionId: scope.sessionId,
      chatType: "direct",
      updatedAt: 1,
    });
    await persistSessionTranscriptTurn(scope, {
      updateMode: "none",
      messages: [
        { message: { role: "user", content: "ordinary user turn", timestamp: 1_000 } },
        { message: { role: "assistant", content: "ordinary assistant reply", timestamp: 2_000 } },
      ],
    });

    const ordinaryCtx: FinalizedMsgContext = {
      Body: "follow-up",
      RawBody: "follow-up",
      CommandBody: "follow-up",
      From: "telegram:123",
      To: "telegram:123",
      SessionKey: scope.sessionKey,
      AgentId: scope.agentId,
      Provider: "telegram",
      ChatType: "direct",
      Timestamp: 5_000,
      CommandAuthorized: false,
      SessionTranscriptContext: {
        chatWindow: true,
        deliveryOnly: true,
        historyLimit: 10,
        senderLabels: { assistant: "OpenClaw", user: "User" },
      },
    };
    await runPreparedChannelTurn({
      channel: "telegram",
      routeSessionKey: scope.sessionKey,
      storePath: scope.storePath,
      ctxPayload: ordinaryCtx,
      recordInboundSession: async () => undefined,
      runDispatch: async () => ({ queuedFinal: false }),
    });
    expect(ordinaryCtx.ChannelStructuredContext).toBeUndefined();

    expect(
      await appendAssistantMessageToSessionTranscript({
        ...scope,
        text: "Time for your weigh-in.",
        idempotencyKey: "cron-weigh-in",
        deliveryMirror: { kind: CRON_DIRECT_DELIVERY_CONTEXT_KIND },
      }),
    ).toMatchObject({ ok: true });

    const restartFollowUpCtx: FinalizedMsgContext = {
      ...ordinaryCtx,
      Body: "200 pounds",
      RawBody: "200 pounds",
      CommandBody: "200 pounds",
      Timestamp: Date.now() + 1_000,
    };
    let prompt = "";
    await runPreparedChannelTurn({
      channel: "telegram",
      routeSessionKey: scope.sessionKey,
      storePath: scope.storePath,
      ctxPayload: restartFollowUpCtx,
      recordInboundSession: async () => undefined,
      runDispatch: async () => {
        prompt = buildInboundUserContextPrefix(restartFollowUpCtx);
        return { queuedFinal: false };
      },
    });

    expect(restartFollowUpCtx.ChannelStructuredContext).toMatchObject([
      {
        source: "session",
        type: "chat_window",
        payload: {
          messages: [{ sender: "OpenClaw", body: "Time for your weigh-in." }],
        },
      },
    ]);
    expect(prompt).toContain("Time for your weigh-in.");
    expect(prompt).not.toContain("ordinary user turn");
    expect(prompt).not.toContain("ordinary assistant reply");
  });
});
