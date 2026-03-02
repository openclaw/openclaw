import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { monitorWebInbox } from "./inbound.js";
import {
  DEFAULT_ACCOUNT_ID,
  getAuthDir,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  upsertPairingRequestMock,
} from "./monitor-inbox.test-harness.js";

const nowSeconds = (offsetMs = 0) => Math.floor((Date.now() + offsetMs) / 1000);
const DEFAULT_MESSAGES_CFG = {
  messagePrefix: undefined,
  responsePrefix: undefined,
} as const;

function createAllowListConfig(allowFrom: string[]) {
  return {
    channels: {
      whatsapp: {
        allowFrom,
      },
    },
    messages: DEFAULT_MESSAGES_CFG,
  };
}

async function openInboxMonitor(onMessage = vi.fn()) {
  const listener = await monitorWebInbox({
    verbose: false,
    accountId: DEFAULT_ACCOUNT_ID,
    authDir: getAuthDir(),
    onMessage,
  });
  return { onMessage, listener, sock: getSock() };
}

async function expectOutboundDmSkipsPairing(params: {
  selfChatMode: boolean;
  messageId: string;
  body: string;
}) {
  mockLoadConfig.mockReturnValue({
    channels: {
      whatsapp: {
        dmPolicy: "pairing",
        selfChatMode: params.selfChatMode,
      },
    },
    messages: DEFAULT_MESSAGES_CFG,
  });

  const onMessage = vi.fn();
  const listener = await monitorWebInbox({
    verbose: false,
    accountId: DEFAULT_ACCOUNT_ID,
    authDir: getAuthDir(),
    onMessage,
  });
  const sock = getSock();

  try {
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: params.messageId,
            fromMe: true,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: params.body },
          messageTimestamp: nowSeconds(),
        },
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
  } finally {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: DEFAULT_MESSAGES_CFG,
    });
    await listener.close();
  }
}

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  it("allows messages from senders in allowFrom list", async () => {
    mockLoadConfig.mockReturnValue(createAllowListConfig(["+111", "+999"]));

    const { onMessage, listener, sock } = await openInboxMonitor();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "auth1", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "authorized message" },
          messageTimestamp: nowSeconds(60_000),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should call onMessage for authorized senders
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "authorized message",
        from: "+999",
        senderE164: "+999",
      }),
    );

    await listener.close();
  });

  it("allows same-phone messages even if not in allowFrom", async () => {
    // Same-phone mode: when from === selfJid, should always be allowed
    // This allows users to message themselves even with restrictive allowFrom
    mockLoadConfig.mockReturnValue(createAllowListConfig(["+111"]));

    const { onMessage, listener, sock } = await openInboxMonitor();

    // Message from self (sock.user.id is "123@s.whatsapp.net" in mock)
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "self1", fromMe: false, remoteJid: "123@s.whatsapp.net" },
          message: { conversation: "self message" },
          messageTimestamp: nowSeconds(60_000),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should allow self-messages even if not in allowFrom
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "self message", from: "+123" }),
    );

    await listener.close();
  });

  it("locks down when no config is present (pairing for unknown senders)", async () => {
    // No config file => locked-down defaults apply (pairing for unknown senders).
    // Pairing reply is only sent to owner (same number); non-owner gets no reply.
    mockLoadConfig.mockReturnValue({});
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    const { onMessage, listener, sock } = await openInboxMonitor();

    // Message from someone else (+999, not self) should be blocked; no pairing reply to non-owner
    const upsertBlocked = {
      type: "notify",
      messages: [
        {
          key: {
            id: "no-config-1",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "ping" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsertBlocked);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();

    const upsertBlockedAgain = {
      type: "notify",
      messages: [
        {
          key: {
            id: "no-config-1b",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "ping again" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsertBlockedAgain);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();

    // Message from self should be allowed
    const upsertSelf = {
      type: "notify",
      messages: [
        {
          key: {
            id: "no-config-2",
            fromMe: false,
            remoteJid: "123@s.whatsapp.net",
          },
          message: { conversation: "self ping" },
          messageTimestamp: nowSeconds(),
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsertSelf);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "self ping",
        from: "+123",
        to: "+123",
      }),
    );

    await listener.close();
  });

  it("skips pairing replies for outbound DMs in same-phone mode", async () => {
    await expectOutboundDmSkipsPairing({
      selfChatMode: true,
      messageId: "fromme-1",
      body: "hello",
    });
  });

  it("skips pairing replies for outbound DMs when same-phone mode is disabled", async () => {
    await expectOutboundDmSkipsPairing({
      selfChatMode: false,
      messageId: "fromme-2",
      body: "hello again",
    });
  });

  it("handles append messages by marking them read but skipping auto-reply", async () => {
    const { onMessage, listener, sock } = await openInboxMonitor();

    const upsert = {
      type: "append",
      messages: [
        {
          key: {
            id: "history1",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "old message" },
          messageTimestamp: nowSeconds(),
          pushName: "History Sender",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Verify it WAS marked as read
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "999@s.whatsapp.net",
        id: "history1",
        participant: undefined,
        fromMe: false,
      },
    ]);

    // Verify it WAS NOT passed to onMessage
    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("normalizes participant phone numbers to JIDs in sendReaction", async () => {
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage: vi.fn(),
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
    });
    const sock = getSock();

    await listener.sendReaction("12345@g.us", "msg123", "👍", false, "+6421000000");

    expect(sock.sendMessage).toHaveBeenCalledWith("12345@g.us", {
      react: {
        text: "👍",
        key: {
          remoteJid: "12345@g.us",
          id: "msg123",
          fromMe: false,
          participant: "6421000000@s.whatsapp.net",
        },
      },
    });

    await listener.close();
  });
});
