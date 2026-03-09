import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before imports.
vi.mock("../../accounts.js", () => ({
  resolveWhatsAppAccount: vi.fn(),
}));
vi.mock("../../outbound.js", () => ({
  sendReactionWhatsApp: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../../../globals.js", () => ({
  logVerbose: vi.fn(),
}));
vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(() => "requireMention"),
}));

import { resolveWhatsAppAccount } from "../../accounts.js";
import { sendReactionWhatsApp } from "../../outbound.js";
import type { WebInboundMsg } from "../types.js";
import { maybeSendAckReaction } from "./ack-reaction.js";

const mockedResolveAccount = vi.mocked(resolveWhatsAppAccount);
const mockedSendReaction = vi.mocked(sendReactionWhatsApp);

function makeMsg(overrides: Partial<WebInboundMsg> = {}): WebInboundMsg {
  return {
    id: "msg-1",
    from: "+15551234567",
    to: "+15559876543",
    body: "hello",
    chatId: "chat-1",
    chatType: "direct",
    ...overrides,
  } as WebInboundMsg;
}

function baseCfg() {
  return {
    channels: {
      whatsapp: {
        allowFrom: ["*"],
        ackReaction: { emoji: "👍", direct: true, group: "mentions" as const },
      },
    },
  } as ReturnType<typeof import("../../../config/config.js").loadConfig>;
}

describe("maybeSendAckReaction account-level config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses account-level ackReaction when accountId is provided", () => {
    const accountEmoji = "🎉";
    mockedResolveAccount.mockReturnValue({
      accountId: "acct-2",
      enabled: true,
      sendReadReceipts: true,
      authDir: "/tmp/auth",
      isLegacyAuthDir: false,
      ackReaction: { emoji: accountEmoji, direct: true, group: "mentions" as const },
    });

    maybeSendAckReaction({
      cfg: baseCfg(),
      msg: makeMsg(),
      agentId: "main",
      sessionKey: "sess-1",
      conversationId: "conv-1",
      verbose: false,
      accountId: "acct-2",
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(mockedResolveAccount).toHaveBeenCalledWith({
      cfg: expect.anything(),
      accountId: "acct-2",
    });
    // Should send with account-level emoji, not root-level "👍".
    expect(mockedSendReaction).toHaveBeenCalledWith(
      "chat-1",
      "msg-1",
      accountEmoji,
      expect.objectContaining({ accountId: "acct-2" }),
    );
  });

  it("falls back to root config when accountId is undefined", () => {
    const rootEmoji = "👍";
    mockedResolveAccount.mockReturnValue({
      accountId: "default",
      enabled: true,
      sendReadReceipts: true,
      authDir: "/tmp/auth",
      isLegacyAuthDir: false,
      ackReaction: { emoji: rootEmoji, direct: true, group: "mentions" as const },
    });

    maybeSendAckReaction({
      cfg: baseCfg(),
      msg: makeMsg(),
      agentId: "main",
      sessionKey: "sess-1",
      conversationId: "conv-1",
      verbose: false,
      // accountId omitted — should pass undefined to resolveWhatsAppAccount.
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(mockedResolveAccount).toHaveBeenCalledWith({
      cfg: expect.anything(),
      accountId: undefined,
    });
    expect(mockedSendReaction).toHaveBeenCalledWith(
      "chat-1",
      "msg-1",
      rootEmoji,
      expect.objectContaining({ accountId: undefined }),
    );
  });

  it("does not send when account-level ackReaction has empty emoji", () => {
    mockedResolveAccount.mockReturnValue({
      accountId: "acct-3",
      enabled: true,
      sendReadReceipts: true,
      authDir: "/tmp/auth",
      isLegacyAuthDir: false,
      ackReaction: { emoji: "", direct: true, group: "mentions" as const },
    });

    maybeSendAckReaction({
      cfg: baseCfg(),
      msg: makeMsg(),
      agentId: "main",
      sessionKey: "sess-1",
      conversationId: "conv-1",
      verbose: false,
      accountId: "acct-3",
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(mockedSendReaction).not.toHaveBeenCalled();
  });
});
