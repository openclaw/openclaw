import { beforeEach, describe, expect, it } from "vitest";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import {
  defaultSlackTestConfig,
  flush,
  getSlackClient,
  getSlackHandlers,
  getSlackTestState,
  resetSlackTestState,
  waitForSlackEvent,
} from "./monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./monitor.js");

const slackTestState = getSlackTestState();
const { sendMock, replyMock } = slackTestState;

beforeEach(() => {
  resetInboundDedupe();
  resetSlackTestState(defaultSlackTestConfig());
});

describe("monitorSlackProvider tool results", () => {
  it("threads top-level replies when replyToMode is all", async () => {
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
          replyToMode: "all",
        },
      },
    };

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) {
      throw new Error("Slack message handler not registered");
    }

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "123",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "123" });
  });

  it("treats parent_user_id as a thread reply even when thread_ts matches ts", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) {
      throw new Error("Slack message handler not registered");
    }

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "123",
        thread_ts: "123",
        parent_user_id: "U2",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

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

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) {
      throw new Error("Slack message handler not registered");
    }

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "123",
        thread_ts: "111.222",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

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

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) {
      throw new Error("Slack message handler not registered");
    }

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "thread reply",
        ts: "123.456",
        thread_ts: "111.222",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

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

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) {
      throw new Error("Slack message handler not registered");
    }

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "thread reply",
        ts: "123.456",
        thread_ts: "111.222",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

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
    slackTestState.config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          replyToMode: "off",
        },
      },
    };

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) {
      throw new Error("Slack message handler not registered");
    }

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "789",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: undefined });
  });

  it("threads first reply when replyToMode is first and message is not threaded", async () => {
    replyMock.mockResolvedValue({ text: "first reply" });
    slackTestState.config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          replyToMode: "first",
        },
      },
    };

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) {
      throw new Error("Slack message handler not registered");
    }

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "789",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    // First reply starts a thread under the incoming message
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "789" });
  });
});
