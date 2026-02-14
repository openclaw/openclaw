import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

let monitorWebChannel: typeof import("./auto-reply.js").monitorWebChannel;

beforeAll(async () => {
  ({ monitorWebChannel } = await import("./auto-reply.js"));
});

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks();

  it("uses per-agent mention patterns for group gating", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: { "*": { requireMention: true } },
        },
      },
      messages: {
        groupChat: { mentionPatterns: ["@global"] },
      },
      agents: {
        list: [
          {
            id: "work",
            groupChat: { mentionPatterns: ["@workbot"] },
          },
        ],
      },
      bindings: [
        {
          agentId: "work",
          match: {
            provider: "whatsapp",
            peer: { kind: "group", id: "123@g.us" },
          },
        },
      ],
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "@global ping",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g1",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });
    expect(resolver).not.toHaveBeenCalled();

    await capturedOnMessage?.({
      body: "@workbot ping",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g2",
      senderE164: "+222",
      senderName: "Bob",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });
    expect(resolver).toHaveBeenCalledTimes(1);
  });
  it("allows group messages when whatsapp groups default disables mention gating", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: { "*": { requireMention: false } },
        },
      },
      messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello group",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-default-off",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    resetLoadConfigMock();
  });
  it("blocks group messages when whatsapp groups is set without a wildcard", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: { "999@g.us": { requireMention: false } },
        },
      },
      messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "@openclaw hello",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-allowlist-block",
      senderE164: "+111",
      senderName: "Alice",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).not.toHaveBeenCalled();
    resetLoadConfigMock();
  });
  it("honors per-group mention overrides when conversationId uses session key", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: {
            "*": { requireMention: true },
            "123@g.us": { requireMention: false },
          },
        },
      },
      messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello group",
      from: "whatsapp:group:123@g.us",
      conversationId: "whatsapp:group:123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-per-group-session-key",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    resetLoadConfigMock();
  });
});
