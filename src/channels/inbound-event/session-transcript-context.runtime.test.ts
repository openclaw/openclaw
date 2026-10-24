import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { readRecentUserAssistantTextForSession } from "../../config/sessions/transcript.js";
import { runPreparedChannelTurn } from "../turn/execution.js";
import { mergeSessionTranscriptContext } from "./session-transcript-context.runtime.js";

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(),
}));

const readRecent = vi.mocked(readRecentUserAssistantTextForSession);

function transcriptPair(question: string, reply: string) {
  return [
    { id: "u1", role: "user" as const, text: question, timestamp: 1_000 },
    { id: "a1", role: "assistant" as const, text: reply, timestamp: 2_000 },
  ];
}

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

type WindowEntry = NonNullable<FinalizedMsgContext["ChannelStructuredContext"]>[number];
function chatWindow(messages: object[], overrides: Partial<WindowEntry> = {}) {
  return [{ label: "Window", type: "chat_window", payload: { messages }, ...overrides }];
}

describe("session transcript inbound context", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    readRecent.mockReset();
  });

  async function merged(overrides: Partial<FinalizedMsgContext> = {}, agentId = "main") {
    const ctx = context(overrides);
    await mergeSessionTranscriptContext({
      agentId,
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });
    return ctx;
  }

  async function runTurn(ctx: FinalizedMsgContext, channel = "slack", render?: () => string) {
    let prompt = "";
    await runPreparedChannelTurn({
      channel,
      routeSessionKey: ctx.SessionKey!,
      storePath: path.join(tempDirs.make("openclaw-session-transcript-context-"), "sessions.json"),
      ctxPayload: ctx,
      recordInboundSession: vi.fn(async () => undefined),
      runDispatch: vi.fn(async () => {
        prompt = render?.() ?? "";
        return { queuedFinal: false };
      }),
    });
    return prompt;
  }

  it("restores Slack assistant context when the live window is empty after restart", async () => {
    readRecent.mockResolvedValue(transcriptPair("deploy at noon", "remind at 11:50"));
    const ctx = context();
    await runTurn(ctx);

    expect(ctx.InboundHistory).toEqual([
      { messageId: "session:u1", sender: "User", body: "deploy at noon", timestamp: 1_000 },
      { messageId: "session:a1", sender: "Assistant", body: "remind at 11:50", timestamp: 2_000 },
    ]);
  });

  it("renders the configured native window without restoring stale transcript content", async () => {
    readRecent.mockResolvedValue([{ role: "user", text: "deleted platform message" }]);
    const ctx = context({
      ChatType: "channel",
      SessionTranscriptContext: { historyLimit: 50, historyKind: "recent" },
      InboundHistory: Array.from({ length: 55 }, (_, index) => ({
        sender: "Alice",
        body: `native-line-${String(index).padStart(2, "0")}`,
        timestamp: index,
      })),
    });
    const prompt = await runTurn(ctx, "slack", () => buildInboundUserContextPrefix(ctx));
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
    const ctx = await merged({ SessionTranscriptContext: { chatWindow: true, historyLimit: 3 } });
    expect(ctx.ChannelStructuredContext).toMatchObject([
      {
        source: "session",
        type: "chat_window",
        payload: { messages: [{ body: "scheduled payload" }] },
      },
    ]);
  });

  it("dedupes the canonical turn against the live window and merges chronologically", async () => {
    readRecent.mockResolvedValue(transcriptPair("cached user turn", "canonical reply"));
    const ctx = await merged({
      InboundHistory: [
        { sender: "Alice", body: "cached user turn", timestamp: 1_000, messageId: "m1" },
        { sender: "Alice", body: "new live turn", timestamp: 3_000, messageId: "m2" },
      ],
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
      { id: "a2", role: "assistant", text: "[[reply_to_current]]Legacy", timestamp: 2_500 },
      { id: "u2", role: "user", text: "follow-up", timestamp: 3_000, sourceChannel: "gateway" },
    ]);
    const ctx = await merged({
      SessionTranscriptContext: {
        historyLimit: 3,
        senderLabels: { assistant: "OpenClaw", user: "User" },
      },
      ChannelStructuredContext: chatWindow(
        [
          { message_id: "42", sender: "OpenClaw (you)", body: "same answer" },
          { message_id: "43", sender: "OpenClaw (you)", body: "Legacy", timestamp_ms: 2_500 },
        ],
        {
          source: "telegram",
          sessionTranscriptDedupeMessageIds: ["a1"],
          sessionTranscriptAssistantTextDedupeKeys: ["text:2500:Legacy"],
        },
      ),
    });

    expect(readRecent.mock.calls[0]?.[0]).not.toHaveProperty("includeCronDirectDeliveryContext");
    expect(readRecent.mock.calls[0]?.[0]).not.toHaveProperty("includeMessageToolSourceReplies");
    expect(ctx.ChannelStructuredContext?.[0]).toMatchObject({
      source: "session",
      payload: {
        messages: [
          { message_id: "42", body: "same answer" },
          { message_id: "43", body: "Legacy" },
          { message_id: "session:u2", sender: "User (gateway)", body: "follow-up" },
        ],
      },
    });
  });

  it("keeps a reply target bounded when it consumes the full window", async () => {
    readRecent.mockResolvedValue([{ id: "a1", role: "assistant", text: "old", timestamp: 1_000 }]);
    const ctx = await merged(
      {
        SessionTranscriptContext: { chatWindow: true, historyLimit: 1 },
        ChannelStructuredContext: chatWindow([{ body: "target", is_reply_target: true }]),
      },
      "",
    );

    expect(ctx.ChannelStructuredContext?.[0]?.payload).toEqual({
      messages: [{ body: "target", is_reply_target: true }],
    });
  });

  it("preserves a provider-owned thread window while enriching a populated session prompt", async () => {
    readRecent.mockResolvedValue(transcriptPair("canonical question", "canonical reply"));
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
      ChannelStructuredContext: chatWindow(graphMessages, {
        label: "Thread history",
        source: "msteams",
        sessionTranscriptMode: "preserve",
      }),
    });

    const prompt = await runTurn(ctx, "msteams", () =>
      buildInboundUserContextPrefix(ctx, { timezone: "UTC" }),
    );

    expect(ctx.ChannelStructuredContext?.[0]).toMatchObject({
      source: "msteams",
      payload: expect.objectContaining({ messages: graphMessages }),
    });
    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
      "canonical reply",
      "pending backlog",
    ]);
    for (const text of ["Graph parent", "Graph reply", "canonical reply", "pending backlog"]) {
      expect(prompt).toContain(text);
    }
  });

  it("fails closed for an unscoped session key without a routed agent owner", async () => {
    await expect(
      merged({ AgentId: undefined, SessionKey: "slack:channel:c1" }, ""),
    ).rejects.toThrow("Session transcript context requires an agent owner.");
    expect(readRecent).not.toHaveBeenCalled();
  });

  it("skips canonical history for session-boundary commands", async () => {
    const ctx = await merged({ CommandBody: "/new summarize this workspace" });
    expect(readRecent).not.toHaveBeenCalled();
    expect(ctx.InboundHistory).toBeUndefined();
  });
});
