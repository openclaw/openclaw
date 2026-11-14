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
import { CRON_DIRECT_DELIVERY_CONTEXT_KIND } from "../../shared/transcript-only-openclaw-assistant.js";
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
  await persistTurn(scope, {
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
    await mirrorReply({
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

it.each(["stop", "error", "aborted", "length", "commentary", "unsettled"])(
  "reconciles original and accepted steering only with completed run evidence (%s)",
  async (completion) => {
    const scope = {
      agentId: "main",
      sessionId: "steering",
      sessionKey: "agent:main:steering",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const user = (id: string, metadata: Record<string, unknown>) => ({
      role: "user",
      content: `request ${id}`,
      __openclaw: { transport: { channel: "discord", messageId: id }, ...metadata },
    });
    await persistTurn(scope, {
      updateMode: "none",
      messages: [
        user("unanswered", { runId: "other-run" }),
        user("original", { runId: "accepted-run" }),
        { role: "assistant", content: "Working", stopReason: "stop", phase: "commentary" },
        user("steering", { runId: "accepted-run", steerTargetRunId: "accepted-run" }),
        user("metadata-light", { steerTargetRunId: "accepted-run" }),
        {
          role: "assistant",
          content: "Combined answer",
          stopReason: ["commentary", "unsettled"].includes(completion) ? "stop" : completion,
          ...(completion === "commentary" ? { phase: "commentary" } : {}),
          __openclaw: {
            mirrorOrigin: "codex-app-server",
            runId: "accepted-run",
            ...(completion !== "unsettled" ? { runTerminal: true } : {}),
          },
        },
      ].map((message) => ({ message })),
    });
    const history = ["unanswered", "original", "steering", "metadata-light", "unseen"].map(
      (messageId) => ({ messageId, sender: "User", body: `request ${messageId}` }),
    );
    const ctx: FinalizedMsgContext = {
      Body: "Next request",
      SessionKey: scope.sessionKey,
      AgentId: scope.agentId,
      Provider: "discord",
      CommandAuthorized: false,
      SessionTranscriptContext: { historyLimit: 10, historyKind: "recent" },
      InboundHistory: history,
    };
    await mergeSessionTranscriptContext({ ...scope, ctx });
    expect(ctx.InboundHistory?.map((entry) => entry.messageId)).toEqual(
      completion === "stop" ? ["unanswered", "unseen"] : history.map((entry) => entry.messageId),
    );
    if (completion === "stop") {
      ctx.InboundHistory = structuredClone(history);
      ctx.InboundHistory.find((entry) => entry.messageId === "original")!.body += " edited";
      await mergeSessionTranscriptContext({ ...scope, ctx });
      expect(ctx.InboundHistory?.map((entry) => entry.messageId)).toEqual([
        "unanswered",
        "original",
        "unseen",
      ]);
      ctx.InboundHistory = structuredClone(history);
      ctx.InboundHistory.find((entry) => entry.messageId === "original")!.media = [
        { url: "https://example.com/image.png" },
      ];
      await mergeSessionTranscriptContext({ ...scope, ctx });
      expect(ctx.InboundHistory?.map((entry) => entry.messageId)).toEqual([
        "unanswered",
        "original",
        "unseen",
      ]);
    }
    for (const entry of await readRecent(scope)) {
      expect(entry).not.toHaveProperty("runId");
      expect(entry).not.toHaveProperty("steerTargetRunId");
    }
  },
);

it.each([
  { userRun: "pending", answerRun: "completed", targetRun: undefined, retained: true },
  { userRun: "completed", answerRun: "completed", targetRun: "pending", retained: true },
  { userRun: "completed", answerRun: "completed", targetRun: undefined, retained: false },
  { userRun: undefined, answerRun: "completed", targetRun: undefined, retained: false },
  { userRun: "pending", answerRun: undefined, targetRun: undefined, retained: false },
])(
  "respects explicit run mismatch and legacy missing identity: %j",
  async ({ userRun, answerRun, targetRun, retained }) => {
    const scope = {
      agentId: "main",
      sessionId: "identity",
      sessionKey: "agent:main:identity",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persistTurn(scope, {
      updateMode: "none",
      messages: [
        {
          role: "user",
          content: "pending",
          __openclaw: {
            transport: { messageId: "pending" },
            runId: userRun,
            steerTargetRunId: targetRun,
          },
        },
        {
          role: "assistant",
          content: "answer",
          stopReason: "stop",
          __openclaw: { runId: answerRun },
        },
      ].map((message) => ({ message })),
    });
    const ctx: FinalizedMsgContext = {
      Body: "next",
      SessionKey: scope.sessionKey,
      AgentId: scope.agentId,
      CommandAuthorized: false,
      SessionTranscriptContext: { historyLimit: 1, historyKind: "recent" },
      InboundHistory: [{ messageId: "pending", sender: "User", body: "pending" }],
    };
    await mergeSessionTranscriptContext({ ...scope, ctx });
    expect(ctx.InboundHistory?.map((entry) => entry.messageId)).toEqual(
      retained ? ["pending"] : [],
    );
  },
);

it.each([
  { content: "" },
  { content: [{ type: "image", data: "fixture", mimeType: "image/png" }] },
])("keeps a textless user as an attribution barrier (%j)", async ({ content }) => {
  const scope = {
    agentId: "main",
    sessionId: "textless",
    sessionKey: "agent:main:textless",
    storePath: path.join(sessionDirs.make(), "sessions.json"),
  };
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await persistTurn(scope, {
    updateMode: "none",
    messages: [
      {
        role: "user",
        content: "unanswered",
        __openclaw: { transport: { messageId: "unanswered" } },
      },
      { role: "user", content },
      { role: "assistant", content: "image answer", stopReason: "stop" },
    ].map((message) => ({ message })),
  });
  const history = [
    { messageId: "unanswered", sender: "User", body: "unanswered" },
    { messageId: "unseen", sender: "User", body: "unseen" },
  ];
  const ctx: FinalizedMsgContext = {
    Body: "next",
    SessionKey: scope.sessionKey,
    AgentId: scope.agentId,
    CommandAuthorized: false,
    SessionTranscriptContext: { historyLimit: 2, historyKind: "recent" },
    InboundHistory: history,
  };
  await mergeSessionTranscriptContext({ ...scope, ctx });
  expect(ctx.InboundHistory).toEqual(history);
  expect((await readRecent(scope)).map((entry) => entry.text)).toEqual([
    "unanswered",
    "image answer",
  ]);
});
