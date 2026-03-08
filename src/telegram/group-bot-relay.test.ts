import type { Message } from "@grammyjs/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachTelegramRelayMeta,
  clearTelegramGroupRelayState,
  publishTelegramGroupRelay,
  readTelegramRelayMeta,
  registerTelegramGroupRelayEndpoint,
  resolveTelegramRelayMessageOwner,
  trackTelegramRelayMessageOwner,
  type TelegramGroupRelayInbound,
} from "./group-bot-relay.js";

describe("telegram group bot relay", () => {
  beforeEach(() => {
    clearTelegramGroupRelayState();
  });

  it("relays mention-targeted group bot messages to matching account", async () => {
    const targetDeliveries: TelegramGroupRelayInbound[] = [];
    const unregisterSource = registerTelegramGroupRelayEndpoint({
      accountId: "knox",
      resolveIdentity: async () => ({
        botUserId: 11,
        botUsername: "knox_bot",
        botDisplayName: "Knox",
      }),
      handleRelay: async () => {},
    });
    const unregisterTarget = registerTelegramGroupRelayEndpoint({
      accountId: "jade",
      resolveIdentity: async () => ({
        botUserId: 22,
        botUsername: "jade_bot",
        botDisplayName: "Jade",
      }),
      handleRelay: async (payload) => {
        targetDeliveries.push(payload);
      },
    });

    await publishTelegramGroupRelay({
      sourceAccountId: "knox",
      isGroup: true,
      chatId: -100123,
      messageId: 700,
      text: "Hey @jade_bot can you help?",
      chain: { chainId: "c1", turn: 0, humanInitiated: true },
    });

    expect(targetDeliveries).toHaveLength(1);
    expect(targetDeliveries[0]?.relayMeta.turn).toBe(1);
    expect(targetDeliveries[0]?.source.accountId).toBe("knox");
    expect(targetDeliveries[0]?.target.accountId).toBe("jade");
    expect(resolveTelegramRelayMessageOwner(-100123, 700)).toBe("knox");

    unregisterSource();
    unregisterTarget();
  });

  it("routes by reply target ownership even without explicit mention", async () => {
    const targetDeliveries: TelegramGroupRelayInbound[] = [];
    registerTelegramGroupRelayEndpoint({
      accountId: "knox",
      resolveIdentity: async () => ({
        botUserId: 11,
        botUsername: "knox_bot",
      }),
      handleRelay: async () => {},
    });
    registerTelegramGroupRelayEndpoint({
      accountId: "jade",
      resolveIdentity: async () => ({
        botUserId: 22,
        botUsername: "jade_bot",
      }),
      handleRelay: async (payload) => {
        targetDeliveries.push(payload);
      },
    });

    const now = Date.now();
    trackTelegramRelayMessageOwner({
      chatId: -100123,
      messageId: 345,
      accountId: "jade",
      recordedAtMs: now,
    });

    await publishTelegramGroupRelay({
      sourceAccountId: "knox",
      isGroup: true,
      chatId: -100123,
      messageId: 701,
      text: "replying without mention",
      replyToMessageId: 345,
      chain: { chainId: "c2", turn: 0, humanInitiated: true },
      sentAtMs: now + 500,
    });

    expect(targetDeliveries).toHaveLength(1);
    expect(targetDeliveries[0]?.replyTargetsRecipient).toBe(true);
    expect(targetDeliveries[0]?.replyToMessageId).toBe(345);
  });

  it("does not relay bot-originated chains that are not human-initiated", async () => {
    const targetHandler = vi.fn(async () => {});
    registerTelegramGroupRelayEndpoint({
      accountId: "a",
      resolveIdentity: async () => ({ botUsername: "a_bot" }),
      handleRelay: async () => {},
    });
    registerTelegramGroupRelayEndpoint({
      accountId: "b",
      resolveIdentity: async () => ({ botUsername: "b_bot" }),
      handleRelay: targetHandler,
    });

    await publishTelegramGroupRelay({
      sourceAccountId: "a",
      isGroup: true,
      chatId: -1001,
      messageId: 77,
      text: "@b_bot ping",
      chain: { chainId: "non-human", turn: 0, humanInitiated: false },
    });

    expect(targetHandler).not.toHaveBeenCalled();
  });

  it("caps relay turn depth and enforces cooldown per chain target", async () => {
    const targetHandler = vi.fn(async () => {});
    registerTelegramGroupRelayEndpoint({
      accountId: "a",
      resolveIdentity: async () => ({ botUsername: "a_bot" }),
      handleRelay: async () => {},
    });
    registerTelegramGroupRelayEndpoint({
      accountId: "b",
      resolveIdentity: async () => ({ botUsername: "b_bot" }),
      handleRelay: targetHandler,
    });

    await publishTelegramGroupRelay({
      sourceAccountId: "a",
      isGroup: true,
      chatId: -1001,
      messageId: 78,
      text: "@b_bot first",
      chain: { chainId: "chain-1", turn: 3, humanInitiated: true },
      sentAtMs: 1_000,
    });
    expect(targetHandler).not.toHaveBeenCalled();

    await publishTelegramGroupRelay({
      sourceAccountId: "a",
      isGroup: true,
      chatId: -1001,
      messageId: 79,
      text: "@b_bot one",
      chain: { chainId: "chain-2", turn: 0, humanInitiated: true },
      sentAtMs: 2_000,
    });
    await publishTelegramGroupRelay({
      sourceAccountId: "a",
      isGroup: true,
      chatId: -1001,
      messageId: 80,
      text: "@b_bot two",
      chain: { chainId: "chain-2", turn: 0, humanInitiated: true },
      sentAtMs: 2_001,
    });
    await publishTelegramGroupRelay({
      sourceAccountId: "a",
      isGroup: true,
      chatId: -1001,
      messageId: 81,
      text: "@b_bot three",
      chain: { chainId: "chain-2", turn: 0, humanInitiated: true },
      sentAtMs: 7_100,
    });

    expect(targetHandler).toHaveBeenCalledTimes(2);
  });

  it("attaches and reads relay chain metadata from message objects", () => {
    const message = {
      message_id: 1,
      date: 1736380800,
      chat: { id: 123, type: "private" as const },
    } as Message;
    const attached = attachTelegramRelayMeta(message, {
      chainId: "meta-chain",
      turn: 2,
      humanInitiated: true,
    });
    const meta = readTelegramRelayMeta(attached);
    expect(meta).toEqual({
      chainId: "meta-chain",
      turn: 2,
      humanInitiated: true,
    });
  });
});
