import { beforeAll, describe, expect, it } from "vitest";
import {
  flush,
  getCloseResolve,
  getConfigMock,
  getReadAllowFromStoreMock,
  getNotificationHandler,
  getReplyMock,
  getRequestMock,
  getSendMock,
  getStopMock,
  getUpsertPairingRequestMock,
  getUpdateLastRouteMock,
  installMonitorIMessageProviderTestHooks,
  setConfigMock,
  waitForSubscribe,
} from "./monitor.test-harness.js";

installMonitorIMessageProviderTestHooks();

let monitorIMessageProvider: typeof import("./monitor.js").monitorIMessageProvider;

beforeAll(async () => {
  ({ monitorIMessageProvider } = await import("./monitor.js"));
});

function startMonitor() {
  return monitorIMessageProvider();
}
const replyMock = getReplyMock();
const requestMock = getRequestMock();
const sendMock = getSendMock();
const readAllowFromStoreMock = getReadAllowFromStoreMock();
const stopMock = getStopMock();
const upsertPairingRequestMock = getUpsertPairingRequestMock();
const updateLastRouteMock = getUpdateLastRouteMock();

type TestConfig = {
  channels: Record<string, unknown> & { imessage: Record<string, unknown> };
  messages: Record<string, unknown>;
  session: Record<string, unknown>;
  [k: string]: unknown;
};

function getConfig(): TestConfig {
  return getConfigMock() as unknown as TestConfig;
}

function notifyMessage(message: unknown) {
  getNotificationHandler()?.({
    method: "message",
    params: { message },
  });
}

async function closeMonitor() {
  for (let i = 0; i < 50; i += 1) {
    const close = getCloseResolve();
    if (close) {
      close();
      return;
    }
    await Promise.resolve();
  }
  for (let i = 0; i < 5; i += 1) {
    const close = getCloseResolve();
    if (close) {
      close();
      return;
    }
    await flush();
  }
  throw new Error("imessage test harness: closeResolve not set");
}

describe("monitorIMessageProvider", () => {
  it("handles default config gating, formatting, and reply context", async () => {
    const run = startMonitor();
    await waitForSubscribe();

    notifyMessage({
      id: 1,
      sender: { nested: "not-a-string" },
      text: "hello",
    });
    await flush();
    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    replyMock.mockClear();
    sendMock.mockClear();

    notifyMessage({
      id: 2,
      chat_id: 99,
      sender: "+15550001111",
      is_from_me: false,
      text: "hello group",
      is_group: true,
    });
    await flush();
    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    replyMock.mockClear();
    sendMock.mockClear();

    replyMock.mockResolvedValueOnce({ text: "yo" });
    notifyMessage({
      id: 3,
      chat_id: 42,
      sender: "+15550002222",
      is_from_me: false,
      text: "@openclaw ping",
      is_group: true,
      chat_name: "Lobster Squad",
      participants: ["+1555", "+1556"],
    });
    await flush();
    expect(replyMock).toHaveBeenCalledOnce();
    {
      const ctx = replyMock.mock.calls[0]?.[0] as { Body?: string; ChatType?: string };
      expect(ctx.ChatType).toBe("group");
      // Sender should appear as prefix in group messages (no redundant [from:] suffix)
      expect(String(ctx.Body ?? "")).toContain("+15550002222:");
      expect(String(ctx.Body ?? "")).not.toContain("[from:");
    }
    expect(sendMock).toHaveBeenCalledWith(
      "chat_id:42",
      "yo",
      expect.objectContaining({ client: expect.any(Object) }),
    );
    replyMock.mockClear();
    sendMock.mockClear();

    notifyMessage({
      id: 4,
      chat_id: 99,
      chat_name: "Test Group",
      sender: "+15550001111",
      is_from_me: false,
      text: "@openclaw hi",
      is_group: true,
      created_at: "2026-01-17T00:00:00Z",
    });
    await flush();
    expect(replyMock).toHaveBeenCalled();
    {
      const ctx = replyMock.mock.calls[0]?.[0];
      const body = ctx?.Body ?? "";
      expect(body).toContain("Test Group id:99");
      expect(body).toContain("+15550001111: @openclaw hi");
    }
    replyMock.mockClear();
    sendMock.mockClear();

    notifyMessage({
      id: 5,
      chat_id: 55,
      sender: "+15550001111",
      is_from_me: false,
      text: "replying now",
      is_group: false,
      reply_to_id: 9001,
      reply_to_text: "original message",
      reply_to_sender: "+15559998888",
    });
    await flush();
    expect(replyMock).toHaveBeenCalled();
    {
      const ctx = replyMock.mock.calls[0]?.[0] as {
        Body?: string;
        ReplyToId?: string;
        ReplyToBody?: string;
        ReplyToSender?: string;
      };
      expect(ctx.ReplyToId).toBe("9001");
      expect(ctx.ReplyToBody).toBe("original message");
      expect(ctx.ReplyToSender).toBe("+15559998888");
      expect(String(ctx.Body ?? "")).toContain("[Replying to +15559998888 id:9001]");
      expect(String(ctx.Body ?? "")).toContain("original message");
    }
    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryContext: expect.objectContaining({
          channel: "imessage",
          to: "+15550001111",
        }),
      }),
    );

    await closeMonitor();
    await run;
  });

  it("allows group messages when imessage groups default disables mention gating", async () => {
    const config = getConfig();
    setConfigMock({
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels.imessage,
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    const run = startMonitor();
    await waitForSubscribe();

    notifyMessage({
      id: 11,
      chat_id: 123,
      sender: "+15550001111",
      is_from_me: false,
      text: "hello group",
      is_group: true,
    });

    await flush();
    await closeMonitor();
    await run;

    expect(replyMock).toHaveBeenCalled();
  });

  it("allows group messages when requireMention is true but no mentionPatterns exist", async () => {
    const config = getConfig();
    setConfigMock({
      ...config,
      messages: {
        ...config.messages,
        groupChat: { mentionPatterns: [] },
      },
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels.imessage,
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    const run = startMonitor();
    await waitForSubscribe();

    notifyMessage({
      id: 12,
      chat_id: 777,
      sender: "+15550001111",
      is_from_me: false,
      text: "hello group",
      is_group: true,
    });

    await flush();
    await closeMonitor();
    await run;

    expect(replyMock).toHaveBeenCalled();
  });

  it("blocks group messages when imessage.groups is set without a wildcard", async () => {
    const config = getConfig();
    setConfigMock({
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels.imessage,
          groups: { "99": { requireMention: false } },
        },
      },
    });

    const run = startMonitor();
    await waitForSubscribe();

    notifyMessage({
      id: 13,
      chat_id: 123,
      sender: "+15550001111",
      is_from_me: false,
      text: "@openclaw hello",
      is_group: true,
    });

    await flush();
    await closeMonitor();
    await run;

    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("treats configured chat_id as a group session even when is_group is false", async () => {
    const config = getConfig();
    setConfigMock({
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels.imessage,
          dmPolicy: "open",
          allowFrom: ["*"],
          groups: { "2": { requireMention: false } },
        },
      },
    });

    const run = startMonitor();
    await waitForSubscribe();

    notifyMessage({
      id: 14,
      chat_id: 2,
      sender: "+15550001111",
      is_from_me: false,
      text: "hello",
      is_group: false,
    });

    await flush();
    await closeMonitor();
    await run;

    expect(replyMock).toHaveBeenCalled();
    const ctx = replyMock.mock.calls[0]?.[0] as {
      ChatType?: string;
      SessionKey?: string;
    };
    expect(ctx.ChatType).toBe("group");
    expect(ctx.SessionKey).toBe("agent:main:imessage:group:2");
  });

  it("prefixes final replies with responsePrefix", async () => {
    const config = getConfig();
    setConfigMock({
      ...config,
      messages: {
        ...config.messages,
        responsePrefix: "PFX",
      },
    });
    replyMock.mockResolvedValue({ text: "final reply" });

    const run = startMonitor();
    await waitForSubscribe();

    notifyMessage({
      id: 7,
      chat_id: 77,
      sender: "+15550001111",
      is_from_me: false,
      text: "hello",
      is_group: false,
    });

    await flush();
    await closeMonitor();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toBe("PFX final reply");
  });

  it("defaults to dmPolicy=pairing behavior when allowFrom is empty", async () => {
    const config = getConfig();
    setConfigMock({
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels.imessage,
          dmPolicy: "pairing",
          allowFrom: [],
          groups: { "*": { requireMention: true } },
        },
      },
    });

    const run = startMonitor();
    await waitForSubscribe();

    notifyMessage({
      id: 99,
      chat_id: 77,
      sender: "+15550001111",
      is_from_me: false,
      text: "hello",
      is_group: false,
    });

    await flush();
    await closeMonitor();
    await run;

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain(
      "Your iMessage sender id: +15550001111",
    );
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Pairing code: PAIRCODE");
  });

  it("honors group allowlist and ignores pairing-store senders in groups", async () => {
    const config = getConfig();
    setConfigMock({
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels.imessage,
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: ["chat_id:101"],
        },
      },
    });
    readAllowFromStoreMock.mockResolvedValue(["+15550003333"]);

    const run = startMonitor();
    await waitForSubscribe();

    replyMock.mockClear();
    sendMock.mockClear();
    notifyMessage({
      id: 3,
      chat_id: 202,
      sender: "+15550003333",
      is_from_me: false,
      text: "@openclaw hi",
      is_group: true,
    });

    await flush();
    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();

    replyMock.mockClear();
    sendMock.mockClear();
    notifyMessage({
      id: 31,
      chat_id: 202,
      sender: "+15550003333",
      is_from_me: false,
      text: "/status",
      is_group: true,
    });

    await flush();
    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();

    replyMock.mockClear();
    sendMock.mockClear();
    notifyMessage({
      id: 33,
      chat_id: 101,
      sender: "+15550003333",
      is_from_me: false,
      text: "@openclaw ok",
      is_group: true,
    });

    await flush();
    await closeMonitor();
    await run;

    expect(replyMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalled();
  });

  it("blocks group messages when groupPolicy is disabled", async () => {
    const config = getConfig();
    setConfigMock({
      ...config,
      channels: {
        ...config.channels,
        imessage: {
          ...config.channels.imessage,
          groupPolicy: "disabled",
        },
      },
    });

    const run = startMonitor();
    await waitForSubscribe();

    notifyMessage({
      id: 10,
      chat_id: 303,
      sender: "+15550003333",
      is_from_me: false,
      text: "@openclaw hi",
      is_group: true,
    });

    await flush();
    await closeMonitor();
    await run;

    expect(replyMock).not.toHaveBeenCalled();
  });

  it("does not trigger unhandledRejection when aborting during shutdown", async () => {
    requestMock.mockImplementation((method: string) => {
      if (method === "watch.subscribe") {
        return Promise.resolve({ subscription: 1 });
      }
      if (method === "watch.unsubscribe") {
        return Promise.reject(new Error("imsg rpc closed"));
      }
      return Promise.resolve({});
    });

    const abortController = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const run = monitorIMessageProvider({
        abortSignal: abortController.signal,
      });
      await waitForSubscribe();
      await flush();

      abortController.abort();
      await flush();

      await closeMonitor();
      await run;
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
    expect(stopMock).toHaveBeenCalled();
  });
});
