import fsSync from "node:fs";
import path from "node:path";
import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { monitorWebInbox } from "./inbound.js";
import {
  DEFAULT_ACCOUNT_ID,
  getAuthDir,
  getSock,
  installWebMonitorInboxUnitTestHooks,
} from "./monitor-inbox.test-harness.js";

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();
  type InboxOnMessage = NonNullable<Parameters<typeof monitorWebInbox>[0]["onMessage"]>;

  async function tick() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function startInboxMonitor(
    onMessage: InboxOnMessage,
    extraOptions: Partial<Parameters<typeof monitorWebInbox>[0]> = {},
  ) {
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      ...extraOptions,
    });
    return { listener, sock: getSock() };
  }

  function buildMessageUpsert(params: {
    id: string;
    remoteJid: string;
    text: string;
    timestamp: number;
    pushName?: string;
    participant?: string;
  }) {
    return {
      type: "notify",
      messages: [
        {
          key: {
            id: params.id,
            fromMe: false,
            remoteJid: params.remoteJid,
            participant: params.participant,
          },
          message: { conversation: params.text },
          messageTimestamp: params.timestamp,
          pushName: params.pushName,
        },
      ],
    };
  }

  async function expectQuotedReplyContext(quotedMessage: unknown) {
    const onMessage = vi.fn(async (msg) => {
      await msg.reply("pong");
    });

    const { listener, sock } = await startInboxMonitor(onMessage);
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "abc", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: {
            extendedTextMessage: {
              text: "reply",
              contextInfo: {
                stanzaId: "q1",
                participant: "111@s.whatsapp.net",
                quotedMessage,
              },
            },
          },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await tick();

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToId: "q1",
        replyToBody: "original",
        replyToSender: "+111",
      }),
    );
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: "pong",
    });

    await listener.close();
  }

  it("streams inbound messages", async () => {
    const onMessage = vi.fn(async (msg) => {
      await msg.sendComposing();
      await msg.reply("pong");
    });

    const { listener, sock } = await startInboxMonitor(onMessage);
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
    const upsert = buildMessageUpsert({
      id: "abc",
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await tick();

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "ping", from: "+999", to: "+123" }),
    );
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "999@s.whatsapp.net",
        id: "abc",
        participant: undefined,
        fromMe: false,
      },
    ]);
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("composing", "999@s.whatsapp.net");
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: "pong",
    });

    await listener.close();
  });

  it("uses shared socketRef for replies after reconnect swap", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef: {
      current: {
        sendMessage: (...args: unknown[]) => Promise<void>;
        sendPresenceUpdate: (...args: unknown[]) => Promise<void>;
      } | null;
    } = {
      current: null,
    };

    const { listener, sock } = await startInboxMonitor(onMessage, {
      socketRef: socketRef as Parameters<typeof monitorWebInbox>[0]["socketRef"],
    });

    const upsert = buildMessageUpsert({
      id: "abc-reconnect",
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });
    sock.ev.emit("messages.upsert", upsert);
    await tick();

    const inbound = (onMessage.mock.calls.at(0)?.at(0) ?? null) as {
      reply: (text: string) => Promise<void>;
      sendMedia: (payload: Record<string, unknown>) => Promise<void>;
      sendComposing: () => Promise<void>;
    } | null;
    expect(inbound).not.toBeNull();

    const replacementSock = {
      sendMessage: vi.fn(async () => undefined),
      sendPresenceUpdate: vi.fn(async () => undefined),
    };
    socketRef.current = replacementSock;

    await inbound?.reply("pong");
    await inbound?.sendMedia({ text: "after-reconnect" });
    await inbound?.sendComposing();

    expect(replacementSock.sendMessage).toHaveBeenNthCalledWith(1, "999@s.whatsapp.net", {
      text: "pong",
    });
    expect(replacementSock.sendMessage).toHaveBeenNthCalledWith(2, "999@s.whatsapp.net", {
      text: "after-reconnect",
    });
    expect(replacementSock.sendPresenceUpdate).toHaveBeenCalledWith(
      "composing",
      "999@s.whatsapp.net",
    );
    expect(sock.sendMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("reports no active socket during reconnect gap", async () => {
    const onMessage = vi.fn(async () => undefined);
    const socketRef: {
      current: {
        sendMessage: (...args: unknown[]) => Promise<void>;
        sendPresenceUpdate: (...args: unknown[]) => Promise<void>;
      } | null;
    } = {
      current: null,
    };

    const { listener, sock } = await startInboxMonitor(onMessage, {
      socketRef: socketRef as Parameters<typeof monitorWebInbox>[0]["socketRef"],
    });

    const upsert = buildMessageUpsert({
      id: "abc-gap",
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });
    sock.ev.emit("messages.upsert", upsert);
    await tick();

    const inbound = (onMessage.mock.calls.at(0)?.at(0) ?? null) as {
      reply: (text: string) => Promise<void>;
      sendMedia: (payload: Record<string, unknown>) => Promise<void>;
      sendComposing: () => Promise<void>;
    } | null;
    expect(inbound).not.toBeNull();

    socketRef.current = null;
    await expect(inbound?.reply("pong")).rejects.toThrow(
      "no active socket - reconnection in progress",
    );
    await expect(inbound?.sendMedia({ text: "after-reconnect" })).rejects.toThrow(
      "no active socket - reconnection in progress",
    );
    await expect(inbound?.sendComposing()).resolves.toBeUndefined();

    await listener.close();
  });

  it("deduplicates redelivered messages by id", async () => {
    const onMessage = vi.fn(async () => {
      return;
    });

    const { listener, sock } = await startInboxMonitor(onMessage);
    const upsert = buildMessageUpsert({
      id: "abc",
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    sock.ev.emit("messages.upsert", upsert);
    await tick();

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("resolves LID JIDs using Baileys LID mapping store", async () => {
    const onMessage = vi.fn(async () => {
      return;
    });

    const { listener, sock } = await startInboxMonitor(onMessage);
    const getPNForLID = vi.spyOn(sock.signalRepository.lidMapping, "getPNForLID");
    sock.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce("999:0@s.whatsapp.net");
    const upsert = buildMessageUpsert({
      id: "abc",
      remoteJid: "999@lid",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await tick();

    expect(getPNForLID).toHaveBeenCalledWith("999@lid");
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "ping", from: "+999", to: "+123" }),
    );

    await listener.close();
  });

  it("resolves LID JIDs via authDir mapping files", async () => {
    const onMessage = vi.fn(async () => {
      return;
    });
    fsSync.writeFileSync(
      path.join(getAuthDir(), "lid-mapping-555_reverse.json"),
      JSON.stringify("1555"),
    );

    const { listener, sock } = await startInboxMonitor(onMessage);
    const getPNForLID = vi.spyOn(sock.signalRepository.lidMapping, "getPNForLID");
    const upsert = buildMessageUpsert({
      id: "abc",
      remoteJid: "555@lid",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await tick();

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "ping", from: "+1555", to: "+123" }),
    );
    expect(getPNForLID).not.toHaveBeenCalled();

    await listener.close();
  });

  it("resolves group participant LID JIDs via Baileys mapping", async () => {
    const onMessage = vi.fn(async () => {
      return;
    });

    const { listener, sock } = await startInboxMonitor(onMessage);
    const getPNForLID = vi.spyOn(sock.signalRepository.lidMapping, "getPNForLID");
    sock.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce("444:0@s.whatsapp.net");
    const upsert = buildMessageUpsert({
      id: "abc",
      remoteJid: "123@g.us",
      participant: "444@lid",
      text: "ping",
      timestamp: 1_700_000_000,
    });

    sock.ev.emit("messages.upsert", upsert);
    await tick();

    expect(getPNForLID).toHaveBeenCalledWith("444@lid");
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "ping",
        from: "123@g.us",
        senderE164: "+444",
        chatType: "group",
      }),
    );

    await listener.close();
  });

  it("does not block follow-up messages when handler is pending", async () => {
    let resolveFirst: (() => void) | null = null;
    const onMessage = vi.fn(async () => {
      if (!resolveFirst) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
    });

    const { listener, sock } = await startInboxMonitor(onMessage);
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "abc1", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
        },
        {
          key: { id: "abc2", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "pong" },
          messageTimestamp: 1_700_000_001,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await tick();

    expect(onMessage).toHaveBeenCalledTimes(2);

    (resolveFirst as (() => void) | null)?.();
    await listener.close();
  });

  it("captures reply context from quoted messages", async () => {
    await expectQuotedReplyContext({ conversation: "original" });
  });

  it("captures reply context from wrapped quoted messages", async () => {
    await expectQuotedReplyContext({
      viewOnceMessageV2Extension: {
        message: { conversation: "original" },
      },
    });
  });
});
