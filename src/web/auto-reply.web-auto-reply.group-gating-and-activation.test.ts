import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { expectInboundContextContract } from "../../test/helpers/inbound-contract.js";
import { setLoggerOverride } from "../logging.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  makeSessionStore,
  resetLoadConfigMock,
  rmDirWithRetries,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

let monitorWebChannel: typeof import("./auto-reply.js").monitorWebChannel;
let SILENT_REPLY_TOKEN: typeof import("./auto-reply.js").SILENT_REPLY_TOKEN;
let lastRouteSpy: { mockRestore: () => void } | undefined;

beforeAll(async () => {
  ({ monitorWebChannel, SILENT_REPLY_TOKEN } = await import("./auto-reply.js"));
  const lastRoute = await import("./auto-reply/monitor/last-route.js");
  lastRouteSpy = vi
    .spyOn(lastRoute, "updateLastRouteInBackground")
    .mockImplementation(() => undefined);
});

afterAll(() => {
  lastRouteSpy?.mockRestore();
  lastRouteSpy = undefined;
});

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks();

  it("requires mention in group chats and injects history when replying", async () => {
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
      body: "hello group",
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
      body: "@bot ping",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g2",
      senderE164: "+222",
      senderName: "Bob",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      sendComposing,
      reply,
      sendMedia,
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

  it("supports always-on group activation with silent token and clears pending history", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi
      .fn()
      .mockResolvedValueOnce({ text: SILENT_REPLY_TOKEN })
      .mockResolvedValueOnce({ text: "ok" });

    const { storePath, cleanup } = await makeSessionStore({
      "agent:main:whatsapp:group:123@g.us": {
        sessionId: "g-1",
        updatedAt: Date.now(),
        groupActivation: "always",
      },
    });

    setLoadConfigMock(() => ({
      messages: {
        groupChat: { mentionPatterns: ["@openclaw"] },
      },
      session: { store: storePath },
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
      body: "first",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-always-1",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();

    await capturedOnMessage?.({
      body: "second",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-always-2",
      senderE164: "+222",
      senderName: "Bob",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(2);
    const payload = resolver.mock.calls[1][0];
    expect(payload.Body).not.toContain("Chat messages since your last reply");
    expect(payload.Body).not.toContain("Alice (+111): first");
    expect(payload.Body).not.toContain("[message_id: g-always-1]");
    expect(payload.Body).toContain("second");
    expectInboundContextContract(payload);
    expect(payload.SenderName).toBe("Bob");
    expect(payload.SenderE164).toBe("+222");
    expect(reply).toHaveBeenCalledTimes(1);

    await cleanup();
    resetLoadConfigMock();
  });

  it("ignores JID mentions in self-chat mode (group chats)", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          // Self-chat heuristic: allowFrom includes selfE164.
          allowFrom: ["+999"],
          groups: { "*": { requireMention: true } },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\bopenclaw\\b"],
        },
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

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    // WhatsApp @mention of the owner should NOT trigger the bot in self-chat mode.
    await capturedOnMessage?.({
      body: "@owner ping",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-self-1",
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

    // Text-based mentionPatterns still work (user can type "openclaw" explicitly).
    await capturedOnMessage?.({
      body: "openclaw ping",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-self-2",
      senderE164: "+222",
      senderName: "Bob",
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);

    resetLoadConfigMock();
  });

  it("emits heartbeat logs with connection metadata", async () => {
    vi.useFakeTimers();
    const logPath = `/tmp/openclaw-heartbeat-${crypto.randomUUID()}.log`;
    setLoggerOverride({ level: "trace", file: logPath });

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const controller = new AbortController();
    const listenerFactory = vi.fn(async () => {
      const onClose = new Promise<void>(() => {
        // never resolves; abort will short-circuit
      });
      return { close: vi.fn(), onClose };
    });

    const run = monitorWebChannel(
      false,
      listenerFactory,
      true,
      async () => ({ text: "ok" }),
      runtime as never,
      controller.signal,
      {
        heartbeatSeconds: 1,
        reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 1, factor: 1.1 },
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.runAllTimersAsync();
    await run.catch(() => {});

    const content = await fs.readFile(logPath, "utf-8");
    expect(content).toMatch(/web-heartbeat/);
    expect(content).toMatch(/connectionId/);
    expect(content).toMatch(/messagesHandled/);
  });

  it("logs outbound replies to file", async () => {
    const logPath = `/tmp/openclaw-log-test-${crypto.randomUUID()}.log`;
    setLoggerOverride({ level: "trace", file: logPath });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "auto" });
    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1",
      to: "+2",
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    const content = await fs.readFile(logPath, "utf-8");
    expect(content).toMatch(/web-auto-reply/);
    expect(content).toMatch(/auto/);
  });
});
