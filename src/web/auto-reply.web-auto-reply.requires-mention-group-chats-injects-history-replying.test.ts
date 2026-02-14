import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createWebInboundDeliverySpies,
  createWebListenerFactoryCapture,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  rmDirWithRetries,
  sendWebGroupInboundMessage,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

let monitorWebChannel: typeof import("./auto-reply.js").monitorWebChannel;

beforeAll(async () => {
  ({ monitorWebChannel } = await import("./auto-reply.js"));
});

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks();

  it("requires mention in group chats and injects history when replying", async () => {
    const spies = createWebInboundDeliverySpies();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    const { listenerFactory, getOnMessage } = createWebListenerFactoryCapture();

    await monitorWebChannel(false, listenerFactory, false, resolver);
    const onMessage = getOnMessage();
    expect(onMessage).toBeDefined();

    await sendWebGroupInboundMessage({
      onMessage: onMessage!,
      spies,
      body: "hello group",
      id: "g1",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
    });

    expect(resolver).not.toHaveBeenCalled();

    await sendWebGroupInboundMessage({
      onMessage: onMessage!,
      spies,
      body: "@bot ping",
      id: "g2",
      senderE164: "+222",
      senderName: "Bob",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    const payload = resolver.mock.calls[0][0];
    expect(payload.Body).toContain("Chat messages since your last reply");
    expect(payload.Body).toContain("Alice (+111): hello group");
    // Message id hints are not included in prompts anymore.
    expect(payload.Body).not.toContain("[message_id:");
    expect(payload.Body).toContain("@bot ping");
    expect(payload.SenderName).toBe("Bob");
    expect(payload.SenderE164).toBe("+222");
    expect(payload.SenderId).toBe("+222");
  });

  it("bypasses mention gating for owner /new in group chats", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["+111"],
        },
      },
    }));

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "/new",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-new",
      senderE164: "+111",
      senderName: "Owner",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("does not bypass mention gating for non-owner /new in group chats", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["+999"],
        },
      },
    }));

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "/new",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-new-unauth",
      senderE164: "+111",
      senderName: "NotOwner",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).not.toHaveBeenCalled();
  });

  it("bypasses mention gating for owner /status in group chats", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["+111"],
        },
      },
    }));

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "/status",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-status",
      senderE164: "+111",
      senderName: "Owner",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("passes conversation id through as From for group replies", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

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
      body: "@bot ping",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g1",
      senderE164: "+222",
      senderName: "Bob",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      sendComposing,
      reply,
      sendMedia,
    });

    const payload = resolver.mock.calls[0]?.[0] as { From?: string; To?: string };
    expect(payload.From).toBe("123@g.us");
    expect(payload.To).toBe("+2");
  });
  it("detects LID mentions using authDir mapping", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-auth-"));

    try {
      await fs.writeFile(
        path.join(authDir, "lid-mapping-555_reverse.json"),
        JSON.stringify("15551234"),
      );

      setLoadConfigMock(() => ({
        channels: {
          whatsapp: {
            allowFrom: ["*"],
            accounts: {
              default: { authDir },
            },
          },
        },
      }));

      await monitorWebChannel(false, listenerFactory, false, resolver);
      expect(capturedOnMessage).toBeDefined();

      await capturedOnMessage?.({
        body: "hello group",
        from: "123@g.us",
        conversationId: "123@g.us",
        chatId: "123@g.us",
        chatType: "group",
        to: "+2",
        id: "g1",
        senderE164: "+111",
        senderName: "Alice",
        selfE164: "+15551234",
        sendComposing,
        reply,
        sendMedia,
      });

      await capturedOnMessage?.({
        body: "@bot ping",
        from: "123@g.us",
        conversationId: "123@g.us",
        chatId: "123@g.us",
        chatType: "group",
        to: "+2",
        id: "g2",
        senderE164: "+222",
        senderName: "Bob",
        mentionedJids: ["555@lid"],
        selfE164: "+15551234",
        selfJid: "15551234@s.whatsapp.net",
        sendComposing,
        reply,
        sendMedia,
      });

      expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
      resetLoadConfigMock();
      await rmDirWithRetries(authDir);
    }
  });
  it("derives self E.164 from LID selfJid for mention gating", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-auth-"));

    try {
      await fs.writeFile(
        path.join(authDir, "lid-mapping-777_reverse.json"),
        JSON.stringify("15550077"),
      );

      setLoadConfigMock(() => ({
        channels: {
          whatsapp: {
            allowFrom: ["*"],
            accounts: {
              default: { authDir },
            },
          },
        },
      }));

      await monitorWebChannel(false, listenerFactory, false, resolver);
      expect(capturedOnMessage).toBeDefined();

      await capturedOnMessage?.({
        body: "@bot ping",
        from: "123@g.us",
        conversationId: "123@g.us",
        chatId: "123@g.us",
        chatType: "group",
        to: "+2",
        id: "g3",
        senderE164: "+333",
        senderName: "Cara",
        mentionedJids: ["777@lid"],
        selfJid: "777@lid",
        sendComposing,
        reply,
        sendMedia,
      });

      expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
      resetLoadConfigMock();
      await rmDirWithRetries(authDir);
    }
  });
  it("sets OriginatingTo to the sender for queued routing", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

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
      body: "hello",
      from: "+15551234567",
      to: "+19998887777",
      id: "m-originating",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    const payload = resolver.mock.calls[0][0];
    expect(payload.OriginatingChannel).toBe("whatsapp");
    expect(payload.OriginatingTo).toBe("+15551234567");
    expect(payload.To).toBe("+19998887777");
    expect(payload.OriginatingTo).not.toBe(payload.To);
  });
});
