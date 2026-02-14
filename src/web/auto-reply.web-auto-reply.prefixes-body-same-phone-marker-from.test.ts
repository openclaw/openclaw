import "./test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TOKEN, monitorWebChannel } from "./auto-reply.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks();

  it("prefixes body with same-phone marker when from === to", async () => {
    // Enable messagePrefix for same-phone mode testing
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: "[same-phone]",
        responsePrefix: undefined,
      },
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

    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1555",
      to: "+1555", // Same phone!
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    // The resolver should receive a prefixed body with the configured marker
    const callArg = resolver.mock.calls[0]?.[0] as { Body?: string };
    expect(callArg?.Body).toBeDefined();
    expect(callArg?.Body).toContain("[WhatsApp +1555");
    expect(callArg?.Body).toContain("[same-phone] hello");
    resetLoadConfigMock();
  });
  it("does not prefix body when from !== to", async () => {
    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1555",
      to: "+2666", // Different phones
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    // Body should include envelope but not the same-phone prefix
    const callArg = resolver.mock.calls[0]?.[0] as { Body?: string };
    expect(callArg?.Body).toContain("[WhatsApp +1555");
    expect(callArg?.Body).toContain("hello");
  });
  it("forwards reply-to context to resolver", async () => {
    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      replyToId: "q1",
      replyToBody: "original",
      replyToSender: "+1999",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    const callArg = resolver.mock.calls[0]?.[0] as {
      ReplyToId?: string;
      ReplyToBody?: string;
      ReplyToSender?: string;
      Body?: string;
    };
    expect(callArg.ReplyToId).toBe("q1");
    expect(callArg.ReplyToBody).toBe("original");
    expect(callArg.ReplyToSender).toBe("+1999");
    expect(callArg.Body).toContain("[Replying to +1999 id:q1]");
    expect(callArg.Body).toContain("original");
  });
  it("applies responsePrefix to regular replies", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "hello there" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    // Reply should have responsePrefix prepended
    expect(reply).toHaveBeenCalledWith("🦞 hello there");
    resetLoadConfigMock();
  });
  it("applies channel responsePrefix override to replies", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"], responsePrefix: "[WA]" } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "[Global]",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "hello there" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).toHaveBeenCalledWith("[WA] hello there");
    resetLoadConfigMock();
  });
  it("defaults responsePrefix for self-chat replies when unset", async () => {
    setLoadConfigMock(() => ({
      agents: {
        list: [
          {
            id: "main",
            default: true,
            identity: { name: "Mainbot", emoji: "🦞", theme: "space lobster" },
          },
        ],
      },
      channels: { whatsapp: { allowFrom: ["+1555"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "hello there" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hi",
      from: "+1555",
      to: "+1555",
      selfE164: "+1555",
      chatType: "direct",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).toHaveBeenCalledWith("[Mainbot] hello there");
    resetLoadConfigMock();
  });
  it("does not deliver HEARTBEAT_OK responses", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    // Resolver returns exact HEARTBEAT_OK
    const resolver = vi.fn().mockResolvedValue({ text: HEARTBEAT_TOKEN });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "test",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).not.toHaveBeenCalled();
    resetLoadConfigMock();
  });
  it("does not double-prefix if responsePrefix already present", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    // Resolver returns text that already has prefix
    const resolver = vi.fn().mockResolvedValue({ text: "🦞 already prefixed" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "test",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    // Should not double-prefix
    expect(reply).toHaveBeenCalledWith("🦞 already prefixed");
    resetLoadConfigMock();
  });
});
