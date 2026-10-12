import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import { buildChannelSourceTurnId } from "../../auto-reply/reply/source-turn-id.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { conversationIdentityFromMsgContext } from "../../config/sessions/conversation-identity.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  rewindSessionToMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../../config/sessions/session-transcript-reconcile.js";
import { readRecentUserAssistantTextForSession } from "../../config/sessions/transcript.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { runPreparedChannelTurn } from "../turn/execution.js";
import { mergeSessionTranscriptContext } from "./session-transcript-context.runtime.js";

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(),
}));

const readRecent = vi.mocked(readRecentUserAssistantTextForSession);

function context(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "continue",
    RawBody: "continue",
    CommandBody: "continue",
    From: "slack:channel:C1",
    To: "channel:C1",
    SessionKey: "agent:main:slack:channel:c1",
    AgentId: "main",
    Provider: "slack",
    Timestamp: 4_000,
    CommandAuthorized: false,
    SessionTranscriptContext: { historyLimit: 3 },
    ...overrides,
  };
}

describe("session transcript inbound context", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    readRecent.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("restores Slack assistant context when the live window is empty after restart", async () => {
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "deploy at noon", timestamp: 1_000 },
      { id: "a1", role: "assistant", text: "I will remind you at 11:50", timestamp: 2_000 },
    ]);
    const ctx = context();

    await runPreparedChannelTurn({
      channel: "slack",
      routeSessionKey: ctx.SessionKey!,
      storePath: path.join(tempDirs.make("openclaw-session-transcript-context-"), "sessions.json"),
      ctxPayload: ctx,
      recordInboundSession: vi.fn(async () => undefined),
      runDispatch: vi.fn(async () => ({ queuedFinal: false })),
    });

    expect(ctx.InboundHistory).toEqual([
      { messageId: "session:u1", sender: "User", body: "deploy at noon", timestamp: 1_000 },
      {
        messageId: "session:a1",
        sender: "Assistant",
        body: "I will remind you at 11:50",
        timestamp: 2_000,
      },
    ]);
  });

  it("renders the configured native window without restoring stale transcript content", async () => {
    readRecent.mockResolvedValue([
      { id: "deleted", role: "user", text: "deleted platform message", timestamp: 3_000 },
    ]);
    const ctx = context({
      ChatType: "channel",
      SessionTranscriptContext: { historyLimit: 50, historyKind: "recent" },
      InboundHistory: Array.from({ length: 55 }, (_, index) => ({
        sender: "Alice",
        body: `native-line-${String(index).padStart(2, "0")}`,
        timestamp: index,
      })),
    });
    let prompt = "";
    await runPreparedChannelTurn({
      channel: "slack",
      routeSessionKey: ctx.SessionKey!,
      storePath: path.join(tempDirs.make("openclaw-native-history-context-"), "sessions.json"),
      ctxPayload: ctx,
      recordInboundSession: vi.fn(async () => undefined),
      runDispatch: async () => {
        prompt = buildInboundUserContextPrefix(ctx);
        return { queuedFinal: false };
      },
    });
    expect(prompt.match(/native-line-\d{2}/g)).toEqual(
      Array.from({ length: 50 }, (_, index) => `native-line-${String(index + 5).padStart(2, "0")}`),
    );
    expect(prompt).not.toContain("deleted platform message");
  });

  it("restores marked Cron delivery context when no live chat window survives", async () => {
    readRecent.mockImplementation(async (params) =>
      params.includeCronDirectDeliveryContext
        ? [{ id: "cron-1", role: "assistant", text: "scheduled payload", timestamp: 2_000 }]
        : [],
    );
    const ctx = context({
      SessionTranscriptContext: { chatWindow: true, historyLimit: 3 },
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.ChannelStructuredContext).toEqual([
      expect.objectContaining({
        source: "session",
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [expect.objectContaining({ body: "scheduled payload" })],
        }),
      }),
    ]);
  });

  it("dedupes the canonical turn against the live window and merges chronologically", async () => {
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "cached user turn", timestamp: 1_000 },
      { id: "a1", role: "assistant", text: "canonical reply", timestamp: 2_000 },
    ]);
    const ctx = context({
      InboundHistory: [
        { sender: "Alice", body: "cached user turn", timestamp: 1_000, messageId: "m1" },
        { sender: "Alice", body: "new live turn", timestamp: 3_000, messageId: "m2" },
      ],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
      "cached user turn",
      "canonical reply",
      "new live turn",
    ]);
  });

  it("uses channel projection ids to avoid duplicating rendered assistant replies", async () => {
    readRecent.mockResolvedValue([
      { id: "a1", role: "assistant", text: "**same answer**", timestamp: 2_000 },
      {
        id: "a2",
        role: "assistant",
        text: "[[reply_to_current]]Legacy answer",
        timestamp: 2_500,
      },
      { id: "u2", role: "user", text: "follow-up", timestamp: 3_000, sourceChannel: "gateway" },
    ]);
    const ctx = context({
      SessionTranscriptContext: {
        historyLimit: 3,
        senderLabels: { assistant: "OpenClaw", user: "User" },
      },
      ChannelStructuredContext: [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          sessionTranscriptDedupeMessageIds: ["a1"],
          sessionTranscriptAssistantTextDedupeKeys: ["text:2500:Legacy answer"],
          payload: {
            order: "chronological",
            relation: "selected_for_current_message",
            messages: [
              { message_id: "42", sender: "OpenClaw (you)", body: "same answer" },
              {
                message_id: "43",
                sender: "OpenClaw (you)",
                body: "Legacy answer",
                timestamp_ms: 2_500,
              },
            ],
          },
        },
      ],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(readRecent.mock.calls[0]?.[0]).not.toHaveProperty("includeCronDirectDeliveryContext");
    expect(ctx.ChannelStructuredContext?.[0]).toMatchObject({
      source: "session",
      payload: {
        messages: [
          { message_id: "42", body: "same answer" },
          { message_id: "43", body: "Legacy answer" },
          { message_id: "session:u2", sender: "User (gateway)", body: "follow-up" },
        ],
      },
    });
  });

  it("keeps a reply target bounded when it consumes the full window", async () => {
    readRecent.mockResolvedValue([
      { id: "a1", role: "assistant", text: "older reply", timestamp: 1_000 },
    ]);
    const ctx = context({
      SessionTranscriptContext: { chatWindow: true, historyLimit: 1 },
      ChannelStructuredContext: [
        {
          label: "Conversation context",
          type: "chat_window",
          payload: { messages: [{ body: "target", is_reply_target: true }] },
        },
      ],
    });

    await mergeSessionTranscriptContext({
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.ChannelStructuredContext?.[0]?.payload).toEqual({
      messages: [{ body: "target", is_reply_target: true }],
    });
  });

  it("preserves a provider-owned thread window while enriching a populated session prompt", async () => {
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "canonical question", timestamp: 1_000 },
      { id: "a1", role: "assistant", text: "canonical reply", timestamp: 2_000 },
    ]);
    const graphMessages = [
      { message_id: "graph-parent", sender: "Parent", body: "Graph parent" },
      { message_id: "graph-reply", sender: "Teammate", body: "Graph reply" },
    ];
    const ctx = context({
      ChatType: "channel",
      InboundHistory: [
        { messageId: "pending", sender: "Pending", body: "pending backlog", timestamp: 3_000 },
      ],
      SessionTranscriptContext: { historyLimit: 2 },
      ChannelStructuredContext: [
        {
          label: "Thread history",
          source: "msteams",
          type: "chat_window",
          sessionTranscriptMode: "preserve",
          payload: {
            order: "chronological",
            relation: "before_current_message",
            messages: graphMessages,
          },
        },
      ],
    });

    let prompt = "";
    await runPreparedChannelTurn({
      channel: "msteams",
      routeSessionKey: ctx.SessionKey!,
      storePath: path.join(tempDirs.make("openclaw-teams-transcript-context-"), "sessions.json"),
      ctxPayload: ctx,
      recordInboundSession: vi.fn(async () => undefined),
      runDispatch: vi.fn(async () => {
        prompt = buildInboundUserContextPrefix(ctx, { timezone: "UTC" });
        return { queuedFinal: false };
      }),
    });

    expect(ctx.ChannelStructuredContext?.[0]?.source).toBe("msteams");
    expect(asRecord(ctx.ChannelStructuredContext?.[0]?.payload).messages).toEqual(graphMessages);
    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
      "canonical reply",
      "pending backlog",
    ]);
    expect(prompt).toContain("Graph parent");
    expect(prompt).toContain("Graph reply");
    expect(prompt).toContain("canonical reply");
    expect(prompt).toContain("pending backlog");
  });

  it("drops cached window rows whose transcript identities a rewind cut", async () => {
    const stateDir = tempDirs.make("openclaw-inactive-window-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:telegram:dm:chat-1";
    const storePath = resolveDefaultSessionStorePath("main");
    const scope = { agentId: "main", env, sessionId: "window-source", sessionKey, storePath };
    const ctx = context({
      From: "telegram:chat-1",
      To: "chat-1",
      OriginatingTo: "chat-1",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      AccountId: "acct-1",
      ChatType: "direct",
      SessionKey: sessionKey,
      SessionTranscriptContext: { chatWindow: true, historyLimit: 5 },
    });
    const identity = conversationIdentityFromMsgContext({ ctx });
    expect(identity).toEqual(expect.objectContaining({ channel: "telegram", accountId: "acct-1" }));
    const cutTransportId = buildChannelSourceTurnId({
      provider: identity?.channel,
      accountId: identity?.accountId,
      conversationId: identity?.deliveryTarget,
      messageId: "102",
    });
    expect(cutTransportId).toBeTruthy();
    await upsertSessionEntryCore(scope, { sessionId: "window-source", updatedAt: 1_000 });
    await appendTranscriptEvent(scope, {
      type: "session",
      id: "window-source",
      version: 3,
      timestamp: "2026-07-18T00:00:00.000Z",
    });
    await appendTranscriptMessage(scope, {
      eventId: "user-1",
      parentId: null,
      now: Date.parse("2026-07-18T00:00:01.000Z"),
      message: { role: "user", content: "retained question" },
    });
    await appendTranscriptMessage(scope, {
      eventId: "assistant-1",
      parentId: "user-1",
      now: Date.parse("2026-07-18T00:00:02.000Z"),
      message: { role: "assistant", content: "retained answer" },
    });
    await appendTranscriptMessage(scope, {
      eventId: "user-2",
      parentId: "assistant-1",
      now: Date.parse("2026-07-18T00:00:03.000Z"),
      message: {
        role: "user",
        content: "discarded question",
        idempotencyKey: cutTransportId,
      },
    });
    await appendTranscriptMessage(scope, {
      eventId: "assistant-2",
      parentId: "user-2",
      now: Date.parse("2026-07-18T00:00:04.000Z"),
      message: { role: "assistant", content: "discarded answer" },
    });
    await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
    const rewound = await rewindSessionToMessage({
      agentId: "main",
      env,
      entryId: "user-2",
      sessionKey,
      storePath,
    });
    expect(rewound.status).toBe("created");
    readRecent.mockResolvedValue([
      { id: "user-1", role: "user", text: "retained question", timestamp: 1_000 },
      { id: "assistant-1", role: "assistant", text: "retained answer", timestamp: 2_000 },
    ]);
    ctx.ChannelStructuredContext = [
      {
        label: "Conversation context",
        source: "telegram",
        type: "chat_window",
        payload: {
          messages: [
            { message_id: "101", sender: "Pat", body: "retained question", timestamp_ms: 1_000 },
            {
              message_id: "102",
              sender: "Pat",
              body: "discarded question",
              timestamp_ms: 3_000,
              is_reply_target: true,
            },
            {
              message_id: "103",
              sender: "OpenClaw (you)",
              body: "discarded answer",
              timestamp_ms: 4_000,
              session_transcript_id: "assistant-2",
            },
            { message_id: "104", sender: "Sam", body: "ambient noise", timestamp_ms: 3_500 },
          ],
        },
      },
    ];

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey,
      storePath,
    });

    const messages = asRecord(ctx.ChannelStructuredContext?.[0]?.payload).messages as Array<
      Record<string, unknown>
    >;
    expect(messages.map((message) => message.body)).toEqual([
      "retained question",
      "retained answer",
      "ambient noise",
    ]);
    expect(JSON.stringify(messages)).not.toContain("discarded");
  });

  it("fails closed for an unscoped session key without a routed agent owner", async () => {
    const ctx = context({ AgentId: undefined, SessionKey: "slack:channel:c1" });

    await expect(
      mergeSessionTranscriptContext({
        ctx,
        sessionKey: ctx.SessionKey!,
        storePath: "/tmp/sessions.json",
      }),
    ).rejects.toThrow("Session transcript context requires an agent owner.");
    expect(readRecent).not.toHaveBeenCalled();
  });

  it("skips canonical history for session-boundary commands", async () => {
    const ctx = context({ CommandBody: "/new summarize this workspace" });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(readRecent).not.toHaveBeenCalled();
    expect(ctx.InboundHistory).toBeUndefined();
  });
});
