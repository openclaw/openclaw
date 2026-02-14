import crypto from "node:crypto";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { expectInboundContextContract } from "../../test/helpers/inbound-contract.js";
import { setLoggerOverride } from "../logging.js";
import { monitorWebChannel, SILENT_REPLY_TOKEN } from "./auto-reply.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  makeSessionStore,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks();

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
