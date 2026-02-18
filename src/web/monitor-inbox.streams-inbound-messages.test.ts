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

  async function startInboxMonitor(onMessage: InboxOnMessage) {
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
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

  async function expectQuotedReplyContext(
    quotedMessage: unknown,
    options?: {
      participant?: string;
      expectedReplyToSender?: string;
      mappedPnForLid?: string | null;
    },
  ) {
    const onMessage = vi.fn(async (msg) => {
      await msg.reply("pong");
    });

    const { listener, sock } = await startInboxMonitor(onMessage);
    if (options && "mappedPnForLid" in options) {
      sock.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce(options.mappedPnForLid);
    }
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
                participant: options?.participant ?? "111@s.whatsapp.net",
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
        replyToSender: options?.expectedReplyToSender ?? "+111",
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

  it("keeps generated mentions for named targets in 'tag me and <name>' requests", async () => {
    const onMessage = vi.fn(async (msg) => {
      await msg.reply("@14155550111 @14155550222 done ✅");
    });

    const { listener, sock } = await startInboxMonitor(onMessage);
    const upsert = buildMessageUpsert({
      id: "g-1",
      remoteJid: "120363425190157453@g.us",
      participant: "14155550111@s.whatsapp.net",
      text: "tag me and ankit",
      timestamp: 1_700_000_000,
    });

    sock.ev.emit("messages.upsert", upsert);
    await tick();

    expect(sock.sendMessage).toHaveBeenCalledWith("120363425190157453@g.us", {
      text: "@14155550111 @14155550222 done ✅",
      mentions: ["14155550111@s.whatsapp.net", "14155550222@s.whatsapp.net"],
    });

    await listener.close();
  });

  it("does not inject mentions when model output has none", async () => {
    const onMessage = vi.fn(async (msg) => {
      await msg.reply("done ✅");
    });

    const { listener, sock } = await startInboxMonitor(onMessage);
    const upsert = buildMessageUpsert({
      id: "g-2",
      remoteJid: "120363425190157453@g.us",
      participant: "14155550111@s.whatsapp.net",
      text: "tag me",
      timestamp: 1_700_000_001,
    });

    sock.ev.emit("messages.upsert", upsert);
    await tick();

    expect(sock.sendMessage).toHaveBeenCalledWith("120363425190157453@g.us", {
      text: "done ✅",
    });

    await listener.close();
  });

  it("falls back to sender/self/remaining participant inference for @Name group replies", async () => {
    const onMessage = vi.fn(async (msg) => {
      await msg.reply("😂 @Alice Example @Bob @OpenClaw  \nTeam status update: 2 humans, 1 bot.");
    });

    const { listener, sock } = await startInboxMonitor(onMessage);
    sock.groupMetadata.mockResolvedValue({
      subject: "test-group",
      participants: [
        { id: "14155550111@s.whatsapp.net", phoneNumber: "+14155550111" },
        { id: "14155550222@s.whatsapp.net", phoneNumber: "+14155550222" },
        { id: "14155550333@s.whatsapp.net", phoneNumber: "+14155550333" },
      ],
    });
    const upsert = buildMessageUpsert({
      id: "g-3",
      remoteJid: "120363425190157453@g.us",
      participant: "14155550111@s.whatsapp.net",
      text: "me and ankit and yourself and send something funny, tag all of us",
      timestamp: 1_700_000_002,
      pushName: "Alice Example",
    });

    sock.ev.emit("messages.upsert", upsert);
    await tick();

    const outboundCall = [...sock.sendMessage.mock.calls]
      .toReversed()
      .find(
        ([jid, payload]) =>
          jid === "120363425190157453@g.us" &&
          typeof (payload as { text?: unknown }).text === "string" &&
          ((payload as { text: string }).text.includes("Team status update") ||
            (payload as { text: string }).text.includes("@Alice Example")),
      );

    expect(outboundCall).toBeDefined();
    const payload = outboundCall?.[1] as { text: string; mentions?: string[] };
    expect(payload.mentions).toEqual(
      expect.arrayContaining([
        "14155550111@s.whatsapp.net",
        "14155550222@s.whatsapp.net",
        "14155550333@s.whatsapp.net",
      ]),
    );
    expect(payload.text).toContain("@14155550111");
    expect(payload.text).toContain("@14155550222");
    expect(payload.text).toContain("@14155550333");
    expect(payload.text).not.toContain("@14155550111 Example");
    expect(payload.text).not.toContain("@Alice");
    expect(payload.text).not.toContain("@Bob");
    expect(payload.text).not.toContain("@OpenClaw");
    expect(payload.text).not.toMatch(/\n@14155550111 @14155550222 @14155550333$/);

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

  it("captures reply context from quoted lid participants via mapping", async () => {
    await expectQuotedReplyContext(
      {
        conversation: "original",
      },
      {
        participant: "444@lid",
        mappedPnForLid: "444:0@s.whatsapp.net",
        expectedReplyToSender: "+444",
      },
    );
  });
});
