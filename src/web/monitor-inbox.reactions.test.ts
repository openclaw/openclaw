import { vi } from "vitest";

vi.mock("../media/store.js", () => ({
  saveMediaBuffer: vi.fn().mockResolvedValue({
    id: "mid",
    path: "/tmp/mid",
    size: 1,
    contentType: "image/jpeg",
  }),
}));

const mockLoadConfig = vi.fn().mockReturnValue({
  channels: {
    whatsapp: {
      allowFrom: ["*"],
    },
  },
  messages: {
    messagePrefix: undefined,
    responsePrefix: undefined,
  },
});

const readAllowFromStoreMock = vi.fn().mockResolvedValue([]);
const upsertPairingRequestMock = vi.fn().mockResolvedValue({ code: "PAIRCODE", created: true });

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => mockLoadConfig(),
  };
});

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("./session.js", () => {
  const { EventEmitter } = require("node:events");
  const ev = new EventEmitter();
  const sock = {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    readMessages: vi.fn().mockResolvedValue(undefined),
    updateMediaMessage: vi.fn(),
    logger: {},
    signalRepository: {
      lidMapping: {
        getPNForLID: vi.fn().mockResolvedValue(null),
      },
    },
    user: { id: "123@s.whatsapp.net" },
  };
  return {
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
    getStatusCode: vi.fn(() => 500),
  };
});

const { createWaSocket } = await import("./session.js");
const _getSock = () => (createWaSocket as unknown as () => Promise<ReturnType<typeof mockSock>>)();

function mockSock() {
  const { EventEmitter } = require("node:events");
  const ev = new EventEmitter();
  return {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    readMessages: vi.fn().mockResolvedValue(undefined),
    updateMediaMessage: vi.fn(),
    logger: {},
    signalRepository: {
      lidMapping: {
        getPNForLID: vi.fn().mockResolvedValue(null),
      },
    },
    user: { id: "123@s.whatsapp.net" },
  };
}

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebInboundReaction } from "./inbound/types.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { monitorWebInbox, resetWebInboundDedupe } from "./inbound.js";

const ACCOUNT_ID = "default";
let authDir: string;

describe("web monitor inbox reactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readAllowFromStoreMock.mockResolvedValue([]);
    resetWebInboundDedupe();
    authDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
    fsSync.rmSync(authDir, { recursive: true, force: true });
  });

  it("handles incoming reaction events", async () => {
    const onMessage = vi.fn();
    const onReaction = vi.fn();

    const listener = await monitorWebInbox({
      verbose: false,
      accountId: ACCOUNT_ID,
      authDir,
      onMessage,
      onReaction,
    });

    const sock = await _getSock();

    // Emit a reaction event
    sock.ev.emit("messages.reaction", [
      {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "MSG123ABC",
        },
        reaction: {
          key: {
            remoteJid: "15559876543@s.whatsapp.net",
            participant: "15559876543@s.whatsapp.net",
          },
          text: "👍",
          senderTimestampMs: BigInt(Date.now()),
        },
      },
    ]);

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 100));

    expect(onReaction).toHaveBeenCalledTimes(1);
    const reaction: WebInboundReaction = onReaction.mock.calls[0][0];
    expect(reaction.emoji).toBe("👍");
    expect(reaction.action).toBe("add");
    expect(reaction.targetMessageId).toBe("MSG123ABC");
    expect(reaction.accountId).toBe(ACCOUNT_ID);

    await listener.close();
  });

  it("handles reaction removal (empty emoji)", async () => {
    const onMessage = vi.fn();
    const onReaction = vi.fn();

    const listener = await monitorWebInbox({
      verbose: false,
      accountId: ACCOUNT_ID,
      authDir,
      onMessage,
      onReaction,
    });

    const sock = await _getSock();

    // Emit a reaction removal event (empty text = removed)
    sock.ev.emit("messages.reaction", [
      {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "MSG456DEF",
        },
        reaction: {
          key: {
            remoteJid: "15559876543@s.whatsapp.net",
          },
          text: "", // Empty text means reaction removed
          senderTimestampMs: BigInt(Date.now()),
        },
      },
    ]);

    await new Promise((r) => setTimeout(r, 100));

    expect(onReaction).toHaveBeenCalledTimes(1);
    const reaction: WebInboundReaction = onReaction.mock.calls[0][0];
    expect(reaction.emoji).toBe("");
    expect(reaction.action).toBe("remove");
    expect(reaction.targetMessageId).toBe("MSG456DEF");

    await listener.close();
  });

  it("skips reactions on status/broadcast messages", async () => {
    const onMessage = vi.fn();
    const onReaction = vi.fn();

    const listener = await monitorWebInbox({
      verbose: false,
      accountId: ACCOUNT_ID,
      authDir,
      onMessage,
      onReaction,
    });

    const sock = await _getSock();

    // Emit reactions on status and broadcast JIDs (should be ignored)
    sock.ev.emit("messages.reaction", [
      {
        key: {
          remoteJid: "status@broadcast",
          id: "STATUS123",
        },
        reaction: {
          key: { remoteJid: "15559876543@s.whatsapp.net" },
          text: "❤️",
        },
      },
      {
        key: {
          remoteJid: "123456789@broadcast",
          id: "BROADCAST123",
        },
        reaction: {
          key: { remoteJid: "15559876543@s.whatsapp.net" },
          text: "😂",
        },
      },
    ]);

    await new Promise((r) => setTimeout(r, 100));

    expect(onReaction).not.toHaveBeenCalled();

    await listener.close();
  });

  it("does not call onReaction if callback not provided", async () => {
    const onMessage = vi.fn();
    // No onReaction callback provided

    const listener = await monitorWebInbox({
      verbose: false,
      accountId: ACCOUNT_ID,
      authDir,
      onMessage,
    });

    const sock = await _getSock();

    // Emit a reaction event - should not throw
    sock.ev.emit("messages.reaction", [
      {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "MSG789",
        },
        reaction: {
          key: { remoteJid: "15559876543@s.whatsapp.net" },
          text: "🎉",
        },
      },
    ]);

    await new Promise((r) => setTimeout(r, 100));

    // Should not throw, just silently skip
    await listener.close();
  });

  it("handles multiple reactions in single event", async () => {
    const onMessage = vi.fn();
    const onReaction = vi.fn();

    const listener = await monitorWebInbox({
      verbose: false,
      accountId: ACCOUNT_ID,
      authDir,
      onMessage,
      onReaction,
    });

    const sock = await _getSock();

    // Emit multiple reactions at once
    sock.ev.emit("messages.reaction", [
      {
        key: { remoteJid: "15551111111@s.whatsapp.net", id: "MSG1" },
        reaction: {
          key: { remoteJid: "15552222222@s.whatsapp.net" },
          text: "👍",
        },
      },
      {
        key: { remoteJid: "15553333333@s.whatsapp.net", id: "MSG2" },
        reaction: {
          key: { remoteJid: "15554444444@s.whatsapp.net" },
          text: "❤️",
        },
      },
      {
        key: { remoteJid: "15555555555@s.whatsapp.net", id: "MSG3" },
        reaction: {
          key: { remoteJid: "15556666666@s.whatsapp.net" },
          text: "😂",
        },
      },
    ]);

    await new Promise((r) => setTimeout(r, 100));

    expect(onReaction).toHaveBeenCalledTimes(3);

    const emojis = onReaction.mock.calls.map((call) => call[0].emoji);
    expect(emojis).toEqual(["👍", "❤️", "😂"]);

    await listener.close();
  });

  it("skips reactions with missing remoteJid", async () => {
    const onMessage = vi.fn();
    const onReaction = vi.fn();

    const listener = await monitorWebInbox({
      verbose: false,
      accountId: ACCOUNT_ID,
      authDir,
      onMessage,
      onReaction,
    });

    const sock = await _getSock();

    // Emit reaction with missing remoteJid
    sock.ev.emit("messages.reaction", [
      {
        key: {
          remoteJid: null, // Missing
          id: "MSG123",
        },
        reaction: {
          key: { remoteJid: "15559876543@s.whatsapp.net" },
          text: "👍",
        },
      },
    ]);

    await new Promise((r) => setTimeout(r, 100));

    expect(onReaction).not.toHaveBeenCalled();

    await listener.close();
  });
});
