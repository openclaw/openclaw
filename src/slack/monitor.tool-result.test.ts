import { beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_CONTEXT_MARKER } from "../auto-reply/reply/history.js";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import { CURRENT_MESSAGE_MARKER } from "../auto-reply/reply/mentions.js";
import {
  defaultSlackTestConfig,
  getSlackTestState,
  getSlackClient,
  getSlackHandlerOrThrow,
  resetSlackTestState,
  runSlackMessageOnce,
  startSlackMonitor,
  stopSlackMonitor,
} from "./monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./monitor.js");

const slackTestState = getSlackTestState();
const { sendMock, replyMock, reactMock, upsertPairingRequestMock } = slackTestState;

beforeEach(() => {
  resetInboundDedupe();
  resetSlackTestState(defaultSlackTestConfig());
});

describe("monitorSlackProvider tool results", () => {
  type SlackMessageEvent = {
    type: "message";
    user: string;
    text: string;
    ts: string;
    channel: string;
    channel_type: "im" | "channel";
    thread_ts?: string;
    parent_user_id?: string;
  };

  function makeSlackMessageEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return {
      type: "message",
      user: "U1",
      text: "hello",
      ts: "123",
      channel: "C1",
      channel_type: "im",
      ...overrides,
    };
  }

  function setDirectMessageReplyMode(replyToMode: "off" | "all" | "first") {
    slackTestState.config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          replyToMode,
        },
      },
    };
  }

  function firstReplyCtx(): { WasMentioned?: boolean } {
    return (replyMock.mock.calls[0]?.[0] ?? {}) as { WasMentioned?: boolean };
  }

  async function runDirectMessageEvent(ts: string, extraEvent: Record<string, unknown> = {}) {
    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({ ts, ...extraEvent }),
    });
  }

  async function runChannelThreadReplyEvent() {
    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        text: "thread reply",
        ts: "123.456",
        thread_ts: "111.222",
        channel_type: "channel",
      }),
    });
  }

  function setPairingOnlyDirectMessages() {
    const currentConfig = slackTestState.config as {
      channels?: { slack?: Record<string, unknown> };
    };
    slackTestState.config = {
      ...currentConfig,
      channels: {
        ...currentConfig.channels,
        slack: {
          ...currentConfig.channels?.slack,
          dm: { enabled: true, policy: "pairing", allowFrom: [] },
        },
      },
    };
  }

  it("skips tool summaries with responsePrefix", async () => {
    replyMock.mockResolvedValue({ text: "final reply" });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent(),
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toBe("PFX final reply");
  });

  it("drops events with mismatched api_app_id", async () => {
    const client = getSlackClient();
    if (!client) {
      throw new Error("Slack client not registered");
    }
    (client.auth as { test: ReturnType<typeof vi.fn> }).test.mockResolvedValue({
      user_id: "bot-user",
      team_id: "T1",
      api_app_id: "A1",
    });

    await runSlackMessageOnce(
      monitorSlackProvider,
      {
        body: { api_app_id: "A2", team_id: "T1" },
        event: makeSlackMessageEvent(),
      },
      { appToken: "xapp-1-A1-abc" },
    );

    expect(sendMock).not.toHaveBeenCalled();
    expect(replyMock).not.toHaveBeenCalled();
  });

  it("does not derive responsePrefix from routed agent identity when unset", async () => {
    slackTestState.config = {
      agents: {
        list: [
          {
            id: "main",
            default: true,
            identity: { name: "Mainbot", theme: "space lobster", emoji: "🦞" },
          },
          {
            id: "rich",
            identity: { name: "Richbot", theme: "lion bot", emoji: "🦁" },
          },
        ],
      },
      bindings: [
        {
          agentId: "rich",
          match: { channel: "slack", peer: { kind: "direct", id: "U1" } },
        },
      ],
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: { dm: { enabled: true, policy: "open", allowFrom: ["*"] } },
      },
    };

    replyMock.mockResolvedValue({ text: "final reply" });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent(),
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toBe("final reply");
  });

  it("preserves RawBody without injecting processed room history", async () => {
    slackTestState.config = {
      messages: { ackReactionScope: "group-mentions" },
      channels: {
        slack: {
          historyLimit: 5,
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { "*": { requireMention: false } },
        },
      },
    };

    let capturedCtx: { Body?: string; RawBody?: string; CommandBody?: string } = {};
    replyMock.mockImplementation(async (ctx: unknown) => {
      capturedCtx = ctx ?? {};
      return undefined;
    });

    const { controller, run } = startSlackMonitor(monitorSlackProvider);
    const handler = await getSlackHandlerOrThrow("message");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "first",
        ts: "123",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await handler({
      event: {
        type: "message",
        user: "U2",
        text: "second",
        ts: "124",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await stopSlackMonitor({ controller, run });

    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(capturedCtx.Body).not.toContain(HISTORY_CONTEXT_MARKER);
    expect(capturedCtx.Body).not.toContain(CURRENT_MESSAGE_MARKER);
    expect(capturedCtx.Body).not.toContain("first");
    expect(capturedCtx.RawBody).toBe("second");
    expect(capturedCtx.CommandBody).toBe("second");
  });

  it("scopes thread history to the thread by default", async () => {
    slackTestState.config = {
      messages: { ackReactionScope: "group-mentions" },
      channels: {
        slack: {
          historyLimit: 5,
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    };

    const capturedCtx: Array<{ Body?: string }> = [];
    replyMock.mockImplementation(async (ctx: unknown) => {
      capturedCtx.push(ctx ?? {});
      return undefined;
    });

    const { controller, run } = startSlackMonitor(monitorSlackProvider);
    const handler = await getSlackHandlerOrThrow("message");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "thread-a-one",
        ts: "200",
        thread_ts: "100",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "<@bot-user> thread-a-two",
        ts: "201",
        thread_ts: "100",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await handler({
      event: {
        type: "message",
        user: "U2",
        text: "<@bot-user> thread-b-one",
        ts: "301",
        thread_ts: "300",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await stopSlackMonitor({ controller, run });

    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(capturedCtx[0]?.Body).toContain("thread-a-one");
    expect(capturedCtx[1]?.Body).not.toContain("thread-a-one");
    expect(capturedCtx[1]?.Body).not.toContain("thread-a-two");
  });

  it("updates assistant thread status when replies start", async () => {
    replyMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[1] ?? {}) as { onReplyStart?: () => Promise<void> | void };
      await opts?.onReplyStart?.();
      return { text: "final reply" };
    });

    setDirectMessageReplyMode("all");
    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent(),
    });

    const client = getSlackClient() as {
      assistant?: { threads?: { setStatus?: ReturnType<typeof vi.fn> } };
    };
    const setStatus = client.assistant?.threads?.setStatus;
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenNthCalledWith(1, {
      token: "bot-token",
      channel_id: "C1",
      thread_ts: "123",
      status: "is typing...",
    });
    expect(setStatus).toHaveBeenNthCalledWith(2, {
      token: "bot-token",
      channel_id: "C1",
      thread_ts: "123",
      status: "",
    });
  });

  async function expectMentionPatternMessageAccepted(text: string): Promise<void> {
    slackTestState.config = {
      messages: {
        responsePrefix: "PFX",
        groupChat: { mentionPatterns: ["\\bopenclaw\\b"] },
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    };
    replyMock.mockResolvedValue({ text: "hi" });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        text,
        channel_type: "channel",
      }),
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(firstReplyCtx().WasMentioned).toBe(true);
  }

  it("accepts channel messages when mentionPatterns match", async () => {
    await expectMentionPatternMessageAccepted("openclaw: hello");
  });

  it("accepts channel messages when mentionPatterns match even if another user is mentioned", async () => {
    await expectMentionPatternMessageAccepted("openclaw: hello <@U2>");
  });

  it("treats replies to bot threads as implicit mentions", async () => {
    slackTestState.config = {
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    };
    replyMock.mockResolvedValue({ text: "hi" });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        text: "following up",
        ts: "124",
        thread_ts: "123",
        parent_user_id: "bot-user",
        channel_type: "channel",
      }),
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(firstReplyCtx().WasMentioned).toBe(true);
  });

  it("accepts channel messages without mention when channels.slack.requireMention is false", async () => {
    slackTestState.config = {
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
          requireMention: false,
        },
      },
    };
    replyMock.mockResolvedValue({ text: "hi" });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        channel_type: "channel",
      }),
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(firstReplyCtx().WasMentioned).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("treats control commands as mentions for group bypass", async () => {
    replyMock.mockResolvedValue({ text: "ok" });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        text: "/elevated off",
        channel_type: "channel",
      }),
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(firstReplyCtx().WasMentioned).toBe(true);
  });

  it("threads replies when incoming message is in a thread", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });
    slackTestState.config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
          replyToMode: "off",
          channels: { C1: { allow: true, requireMention: false } },
        },
      },
    };
    await runChannelThreadReplyEvent();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "111.222" });
  });

  it("ignores replyToId directive when replyToMode is off", async () => {
    replyMock.mockResolvedValue({ text: "forced reply", replyToId: "555" });
    slackTestState.config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: {
          dmPolicy: "open",
          allowFrom: ["*"],
          dm: { enabled: true },
          replyToMode: "off",
        },
      },
    };

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        ts: "789",
      }),
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: undefined });
  });

  it("keeps replyToId directive threading when replyToMode is all", async () => {
    replyMock.mockResolvedValue({ text: "forced reply", replyToId: "555" });
    setDirectMessageReplyMode("all");

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        ts: "789",
      }),
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "555" });
  });

  it("reacts to mention-gated room messages when ackReaction is enabled", async () => {
    replyMock.mockResolvedValue(undefined);
    const client = getSlackClient();
    if (!client) {
      throw new Error("Slack client not registered");
    }
    const conversations = client.conversations as {
      info: ReturnType<typeof vi.fn>;
    };
    conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        text: "<@bot-user> hello",
        ts: "456",
        channel_type: "channel",
      }),
    });

    expect(reactMock).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "456",
      name: "👀",
    });
  });

  it("replies with pairing code when dmPolicy is pairing and no allowFrom is set", async () => {
    setPairingOnlyDirectMessages();

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent(),
    });

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1]).toContain("Your Slack user id: U1");
    expect(sendMock.mock.calls[0]?.[1]).toContain("Pairing code: PAIRCODE");
  });

  it("does not resend pairing code when a request is already pending", async () => {
    setPairingOnlyDirectMessages();
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    const { controller, run } = startSlackMonitor(monitorSlackProvider);
    const handler = await getSlackHandlerOrThrow("message");

    const baseEvent = makeSlackMessageEvent();

    await handler({ event: baseEvent });
    await handler({ event: { ...baseEvent, ts: "124", text: "hello again" } });

    await stopSlackMonitor({ controller, run });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("threads top-level replies when replyToMode is all", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });
    setDirectMessageReplyMode("all");
    await runDirectMessageEvent("123");

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "123" });
  });

  it("treats parent_user_id as a thread reply even when thread_ts matches ts", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        thread_ts: "123",
        parent_user_id: "U2",
      }),
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    const ctx = replyMock.mock.calls[0]?.[0] as {
      SessionKey?: string;
      ParentSessionKey?: string;
    };
    expect(ctx.SessionKey).toBe("agent:main:main:thread:123");
    expect(ctx.ParentSessionKey).toBeUndefined();
  });

  it("keeps thread parent inheritance opt-in", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });

    slackTestState.config = {
      messages: { responsePrefix: "PFX" },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: false } },
          thread: { inheritParent: true },
        },
      },
    };

    await runSlackMessageOnce(monitorSlackProvider, {
      event: makeSlackMessageEvent({
        thread_ts: "111.222",
        channel_type: "channel",
      }),
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    const ctx = replyMock.mock.calls[0]?.[0] as {
      SessionKey?: string;
      ParentSessionKey?: string;
    };
    expect(ctx.SessionKey).toBe("agent:main:slack:channel:c1:thread:111.222");
    expect(ctx.ParentSessionKey).toBe("agent:main:slack:channel:c1");
  });

  it("injects starter context for thread replies", async () => {
    replyMock.mockResolvedValue({ text: "ok" });

    const client = getSlackClient();
    if (client?.conversations?.info) {
      client.conversations.info.mockResolvedValue({
        channel: { name: "general", is_channel: true },
      });
    }
    if (client?.conversations?.replies) {
      client.conversations.replies.mockResolvedValue({
        messages: [{ text: "starter message", user: "U2", ts: "111.222" }],
      });
    }

    slackTestState.config = {
      messages: { responsePrefix: "PFX" },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: false } },
        },
      },
    };

    await runChannelThreadReplyEvent();

    expect(replyMock).toHaveBeenCalledTimes(1);
    const ctx = replyMock.mock.calls[0]?.[0] as {
      SessionKey?: string;
      ParentSessionKey?: string;
      ThreadStarterBody?: string;
      ThreadLabel?: string;
    };
    expect(ctx.SessionKey).toBe("agent:main:slack:channel:c1:thread:111.222");
    expect(ctx.ParentSessionKey).toBeUndefined();
    expect(ctx.ThreadStarterBody).toContain("starter message");
    expect(ctx.ThreadLabel).toContain("Slack thread #general");
  });

  it("scopes thread session keys to the routed agent", async () => {
    replyMock.mockResolvedValue({ text: "ok" });
    slackTestState.config = {
      messages: { responsePrefix: "PFX" },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: false } },
        },
      },
      bindings: [{ agentId: "support", match: { channel: "slack", teamId: "T1" } }],
    };

    const client = getSlackClient();
    if (client?.auth?.test) {
      client.auth.test.mockResolvedValue({
        user_id: "bot-user",
        team_id: "T1",
      });
    }
    if (client?.conversations?.info) {
      client.conversations.info.mockResolvedValue({
        channel: { name: "general", is_channel: true },
      });
    }

    await runChannelThreadReplyEvent();

    expect(replyMock).toHaveBeenCalledTimes(1);
    const ctx = replyMock.mock.calls[0]?.[0] as {
      SessionKey?: string;
      ParentSessionKey?: string;
    };
    expect(ctx.SessionKey).toBe("agent:support:slack:channel:c1:thread:111.222");
    expect(ctx.ParentSessionKey).toBeUndefined();
  });

  it("keeps replies in channel root when message is not threaded (replyToMode off)", async () => {
    replyMock.mockResolvedValue({ text: "root reply" });
    setDirectMessageReplyMode("off");
    await runDirectMessageEvent("789");

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: undefined });
  });

  it("threads first reply when replyToMode is first and message is not threaded", async () => {
    replyMock.mockResolvedValue({ text: "first reply" });
    setDirectMessageReplyMode("first");
    await runDirectMessageEvent("789");

    expect(sendMock).toHaveBeenCalledTimes(1);
    // First reply starts a thread under the incoming message
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "789" });
  });
});
