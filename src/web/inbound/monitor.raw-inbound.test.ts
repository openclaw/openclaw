import "../monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { monitorWebInbox } from "../inbound.js";
import {
  DEFAULT_ACCOUNT_ID,
  getAuthDir,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
} from "../monitor-inbox.test-harness.js";
import type { RawInboundMessage } from "./types.js";

describe("monitorWebInbox - onRawInbound hook", () => {
  installWebMonitorInboxUnitTestHooks();

  async function tick() {
    await new Promise((resolve) => setImmediate(resolve));
  }
  it("should call onRawInbound for messages that PASS access control", async () => {
    const onRawInbound = vi.fn();
    const onMessage = vi.fn();

    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["+111"], // Allow this sender
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
      onRawInbound,
    });

    const sock = getSock();
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "111@s.whatsapp.net",
            id: "test-msg-1",
            fromMe: false,
          },
          message: {
            conversation: "Hello, this should be allowed",
          },
          pushName: "Sender One",
          messageTimestamp: 1234567890,
        },
      ],
    });

    await tick();

    expect(onRawInbound).toHaveBeenCalledTimes(1);
    const rawMsg: RawInboundMessage = onRawInbound.mock.calls[0][0];
    expect(rawMsg.channel).toBe("whatsapp");
    expect(rawMsg.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(rawMsg.chatId).toBe("111@s.whatsapp.net");
    expect(rawMsg.group).toBe(false);
    expect(rawMsg.body).toBe("Hello, this should be allowed");
    expect(rawMsg.fromMe).toBe(false);
    expect(rawMsg.accessAllowed).toBe(false);

    await listener.close();
  });

  it("should call onRawInbound for messages that FAIL access control", async () => {
    const onRawInbound = vi.fn();
    const onMessage = vi.fn();

    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["+111"], // Only allow +111, block others
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
      onRawInbound,
    });

    const sock = getSock();
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "999@s.whatsapp.net",
            id: "test-msg-blocked",
            fromMe: false,
          },
          message: {
            conversation: "This should be blocked",
          },
          pushName: "Blocked User",
          messageTimestamp: 1234567890,
        },
      ],
    });

    await tick();

    // onRawInbound should have been called
    expect(onRawInbound).toHaveBeenCalledTimes(1);
    const rawMsg: RawInboundMessage = onRawInbound.mock.calls[0][0];
    expect(rawMsg.body).toBe("This should be blocked");

    // onMessage should NOT have been called (access control blocked it)
    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("should NOT call onRawInbound for status/broadcast messages", async () => {
    const onRawInbound = vi.fn();
    const onMessage = vi.fn();

    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
      onRawInbound,
    });

    const sock = getSock();
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "status@broadcast",
            id: "status-msg",
            fromMe: false,
          },
          message: {
            conversation: "Status update",
          },
        },
      ],
    });

    await tick();

    // onRawInbound should NOT have been called for status messages
    expect(onRawInbound).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("should handle onRawInbound errors gracefully without breaking message flow", async () => {
    const onRawInbound = vi.fn(() => {
      throw new Error("onRawInbound error");
    });
    const onMessage = vi.fn();

    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["+111"],
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
      onRawInbound,
    });

    const sock = getSock();
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "111@s.whatsapp.net",
            id: "test-msg-error",
            fromMe: false,
          },
          message: {
            conversation: "Test error handling",
          },
          pushName: "Sender One",
          messageTimestamp: 1234567890,
        },
      ],
    });

    await tick();

    // onRawInbound was called and threw
    expect(onRawInbound).toHaveBeenCalledTimes(1);

    // But normal message flow should still work (onMessage should be called)
    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("should extract group information for group messages", async () => {
    const onRawInbound = vi.fn();
    const onMessage = vi.fn();

    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groupPolicy: "open",
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    const listener = await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
      onRawInbound,
    });

    const sock = getSock();

    // Mock groupMetadata for this group
    sock.groupMetadata = vi.fn().mockResolvedValue({
      subject: "Test Group",
      participants: [{ id: "111@s.whatsapp.net" }],
    }) as unknown as typeof sock.groupMetadata;

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "123456789@g.us",
            participant: "111@s.whatsapp.net",
            id: "group-msg-1",
            fromMe: false,
          },
          message: {
            conversation: "Hello from group",
          },
          pushName: "Group Sender",
          messageTimestamp: 1234567890,
        },
      ],
    });

    await tick();

    expect(onRawInbound).toHaveBeenCalledTimes(1);
    const rawMsg: RawInboundMessage = onRawInbound.mock.calls[0][0];
    expect(rawMsg.group).toBe(true);
    expect(rawMsg.chatId).toBe("123456789@g.us");
    expect(rawMsg.groupSubject).toBe("Test Group");
    expect(rawMsg.senderJid).toBe("111@s.whatsapp.net");

    await listener.close();
  });
});
