import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { monitorWebInbox } from "./inbound.js";
import {
  DEFAULT_ACCOUNT_ID,
  getAuthDir,
  getSock,
  installWebMonitorInboxUnitTestHooks,
} from "./monitor-inbox.test-harness.js";

describe("web monitor inbox – offline messages", () => {
  installWebMonitorInboxUnitTestHooks();

  async function tick() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  function buildMessageUpsert(params: {
    id: string;
    remoteJid: string;
    text: string;
    timestamp: number;
    type: "notify" | "append";
    pushName?: string;
  }) {
    return {
      type: params.type,
      messages: [
        {
          key: {
            id: params.id,
            fromMe: false,
            remoteJid: params.remoteJid,
          },
          message: { conversation: params.text },
          messageTimestamp: params.timestamp,
          pushName: params.pushName,
        },
      ],
    };
  }

  it("skips append messages by default", async () => {
    const onMessage = vi.fn(async () => {});
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
    });
    const sock = getSock();

    const upsert = buildMessageUpsert({
      id: "offline-1",
      remoteJid: "999@s.whatsapp.net",
      text: "missed message",
      timestamp: Math.floor(Date.now() / 1000),
      type: "append",
    });

    sock.ev.emit("messages.upsert", upsert);
    await tick();

    expect(onMessage).not.toHaveBeenCalled();
    await listener.close();
  });

  it("processes append messages when replyToOfflineMessages is true", async () => {
    const onMessage = vi.fn(async () => {});
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      replyToOfflineMessages: true,
    });
    const sock = getSock();

    const upsert = buildMessageUpsert({
      id: "offline-2",
      remoteJid: "999@s.whatsapp.net",
      text: "missed message",
      timestamp: Math.floor(Date.now() / 1000),
      type: "append",
    });

    sock.ev.emit("messages.upsert", upsert);
    await tick();

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ body: "missed message" }));
    await listener.close();
  });

  it("skips old append messages even when replyToOfflineMessages is true", async () => {
    vi.useFakeTimers();
    try {
      const now = 1_700_000_600;
      vi.setSystemTime(now * 1000);

      const onMessage = vi.fn(async () => {});
      const listener = await monitorWebInbox({
        verbose: false,
        onMessage,
        accountId: DEFAULT_ACCOUNT_ID,
        authDir: getAuthDir(),
        replyToOfflineMessages: true,
        offlineMessageMaxAgeSeconds: 300,
      });
      const sock = getSock();

      // Message is 600 seconds old (> 300s threshold)
      const upsert = buildMessageUpsert({
        id: "offline-old",
        remoteJid: "999@s.whatsapp.net",
        text: "very old message",
        timestamp: 1_700_000_000,
        type: "append",
      });

      sock.ev.emit("messages.upsert", upsert);
      await vi.runAllTimersAsync();
      await new Promise((resolve) => setImmediate(resolve));

      expect(onMessage).not.toHaveBeenCalled();
      await listener.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
