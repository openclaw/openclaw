import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { monitorWebInbox } from "./inbound.js";
import {
  DEFAULT_ACCOUNT_ID,
  getAuthDir,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
} from "./monitor-inbox.test-harness.js";

const nowSeconds = (offsetMs = 0) => Math.floor((Date.now() + offsetMs) / 1000);

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  it("blocks messages from unauthorized senders not in allowFrom", async () => {
    // Test for auto-recovery fix: early allowFrom filtering prevents Bad MAC errors
    // from unauthorized senders corrupting sessions
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          // Only allow +111
          allowFrom: ["+111"],
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
    });
    const sock = getSock();

    // Message from unauthorized sender +999 (not in allowFrom)
    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "unauth1",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "unauthorized message" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should NOT call onMessage for unauthorized senders
    expect(onMessage).not.toHaveBeenCalled();
    // Should NOT send read receipts for blocked senders (privacy + avoids Baileys Bad MAC churn).
    expect(sock.readMessages).not.toHaveBeenCalled();
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: expect.stringContaining("Your WhatsApp phone number: +999"),
    });
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: expect.stringContaining("Pairing code: PAIRCODE"),
    });

    await listener.close();
  });

  it("skips read receipts in self-chat mode", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          // Self-chat heuristic: allowFrom includes selfE164 (+123).
          allowFrom: ["+123"],
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
    });
    const sock = getSock();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "self1", fromMe: false, remoteJid: "123@s.whatsapp.net" },
          message: { conversation: "self ping" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ from: "+123", to: "+123", body: "self ping" }),
    );
    expect(sock.readMessages).not.toHaveBeenCalled();

    await listener.close();
  });

  it("skips read receipts when disabled", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
      sendReadReceipts: false,
    });
    const sock = getSock();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "rr-off-1", fromMe: false, remoteJid: "222@s.whatsapp.net" },
          message: { conversation: "read receipts off" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(sock.readMessages).not.toHaveBeenCalled();

    await listener.close();
  });

  it("lets group messages through even when sender not in allowFrom", async () => {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["+1234"], groupPolicy: "open" } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
    });
    const sock = getSock();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp3",
            fromMe: false,
            remoteJid: "11111@g.us",
            participant: "999@s.whatsapp.net",
          },
          message: { conversation: "unauthorized group message" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = onMessage.mock.calls[0][0];
    expect(payload.chatType).toBe("group");
    expect(payload.senderE164).toBe("+999");

    await listener.close();
  });

  it("blocks all group messages when groupPolicy is 'disabled'", async () => {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["+1234"], groupPolicy: "disabled" } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
        timestampPrefix: false,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
    });
    const sock = getSock();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-disabled",
            fromMe: false,
            remoteJid: "11111@g.us",
            participant: "999@s.whatsapp.net",
          },
          message: { conversation: "group message should be blocked" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should NOT call onMessage because groupPolicy is disabled
    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("blocks group messages from senders not in groupAllowFrom when groupPolicy is 'allowlist'", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          groupAllowFrom: ["+1234"], // Does not include +999
          groupPolicy: "allowlist",
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
        timestampPrefix: false,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
    });
    const sock = getSock();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-allowlist-blocked",
            fromMe: false,
            remoteJid: "11111@g.us",
            participant: "999@s.whatsapp.net",
          },
          message: { conversation: "unauthorized group sender" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should NOT call onMessage because sender +999 not in groupAllowFrom
    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("allows group messages from senders in groupAllowFrom when groupPolicy is 'allowlist'", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          groupAllowFrom: ["+15551234567"], // Includes the sender
          groupPolicy: "allowlist",
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
        timestampPrefix: false,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
    });
    const sock = getSock();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-allowlist-allowed",
            fromMe: false,
            remoteJid: "11111@g.us",
            participant: "15551234567@s.whatsapp.net",
          },
          message: { conversation: "authorized group sender" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should call onMessage because sender is in groupAllowFrom
    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = onMessage.mock.calls[0][0];
    expect(payload.chatType).toBe("group");
    expect(payload.senderE164).toBe("+15551234567");

    await listener.close();
  });

  it("allows all group senders with wildcard in groupPolicy allowlist", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          groupAllowFrom: ["*"], // Wildcard allows everyone
          groupPolicy: "allowlist",
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
        timestampPrefix: false,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
    });
    const sock = getSock();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-wildcard-test",
            fromMe: false,
            remoteJid: "22222@g.us",
            participant: "9999999999@s.whatsapp.net", // Random sender
          },
          message: { conversation: "wildcard group sender" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should call onMessage because wildcard allows all senders
    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = onMessage.mock.calls[0][0];
    expect(payload.chatType).toBe("group");

    await listener.close();
  });

  it("blocks group messages when groupPolicy allowlist has no groupAllowFrom", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
        timestampPrefix: false,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
    });
    const sock = getSock();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-allowlist-empty",
            fromMe: false,
            remoteJid: "11111@g.us",
            participant: "999@s.whatsapp.net",
          },
          message: { conversation: "blocked by empty allowlist" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });
});
