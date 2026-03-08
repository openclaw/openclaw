import type { UserFromGetMe } from "@grammyjs/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramHandlers } from "./bot-handlers.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import { buildTelegramUpdateKey, type TelegramUpdateKeyContext } from "./bot-updates.js";
import type { TelegramContext } from "./bot/types.js";
import {
  clearTelegramGroupRelayState,
  publishTelegramGroupRelay,
  registerTelegramGroupRelayEndpoint,
  trackTelegramRelayMessageOwner,
} from "./group-bot-relay.js";

type RelayHarness = {
  unregisterRelay: () => void;
  processCalls: TelegramContext[];
  shouldSkipUpdateCalls: TelegramUpdateKeyContext[];
  getMeMock: ReturnType<typeof vi.fn<() => Promise<UserFromGetMe>>>;
};

function createRelayHarness(params?: {
  getMeImpl?: () => Promise<UserFromGetMe>;
  shouldSkipUpdate?: (ctx: TelegramUpdateKeyContext) => boolean;
}): RelayHarness {
  const processCalls: TelegramContext[] = [];
  const shouldSkipUpdateCalls: TelegramUpdateKeyContext[] = [];

  const getMeMock = vi.fn<() => Promise<UserFromGetMe>>(
    params?.getMeImpl ??
      (async () =>
        ({
          id: 22,
          username: "jade_bot",
          first_name: "Jade",
          is_bot: true,
        }) as UserFromGetMe),
  );

  const bot = {
    api: {
      getMe: getMeMock,
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      setMessageReaction: vi.fn(async () => undefined),
      answerCallbackQuery: vi.fn(async () => undefined),
      editMessageText: vi.fn(async () => ({ message_id: 1 })),
      deleteMessage: vi.fn(async () => true),
      getFile: vi.fn(async () => ({ file_path: "media/file.jpg" })),
    },
    on: vi.fn(),
  } as unknown as RegisterTelegramHandlerParams["bot"];

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as RegisterTelegramHandlerParams["logger"];

  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;

  const cfg = {
    channels: {
      telegram: {
        dmPolicy: "open",
        groupPolicy: "open",
        allowFrom: ["*"],
        groups: {
          "*": { enabled: true, requireMention: false },
        },
      },
    },
  } as OpenClawConfig;

  const telegramCfg = {
    dmPolicy: "open",
    groupPolicy: "open",
    allowFrom: ["*"],
    groups: {
      "*": { enabled: true, requireMention: false },
    },
  } as TelegramAccountConfig;

  const unregisterRelay = registerTelegramHandlers({
    cfg,
    accountId: "jade",
    bot,
    opts: { token: "tok" },
    runtime,
    mediaMaxBytes: 8 * 1024 * 1024,
    telegramCfg,
    allowFrom: ["*"],
    groupAllowFrom: ["*"],
    resolveGroupPolicy: () => "open",
    resolveTelegramGroupConfig: () => ({
      groupConfig: { enabled: true, requireMention: false },
      topicConfig: undefined,
    }),
    shouldSkipUpdate: (ctx) => {
      shouldSkipUpdateCalls.push(ctx);
      return params?.shouldSkipUpdate?.(ctx) ?? false;
    },
    processMessage: async (ctx) => {
      processCalls.push(ctx);
    },
    logger,
  });

  return {
    unregisterRelay,
    processCalls,
    shouldSkipUpdateCalls,
    getMeMock,
  };
}

describe("telegram relay handler", () => {
  beforeEach(() => {
    clearTelegramGroupRelayState();
  });

  it("builds synthetic dedupe keys from chat + message id instead of synthetic update_id", async () => {
    const harness = createRelayHarness();
    const unregisterSource = registerTelegramGroupRelayEndpoint({
      accountId: "knox",
      resolveIdentity: async () => ({
        botUserId: 11,
        botUsername: "knox_bot",
        botDisplayName: "Knox",
      }),
      handleRelay: async () => {},
    });

    trackTelegramRelayMessageOwner({ chatId: -1001, messageId: 301, accountId: "jade" });
    trackTelegramRelayMessageOwner({ chatId: -1002, messageId: 302, accountId: "jade" });

    try {
      await publishTelegramGroupRelay({
        sourceAccountId: "knox",
        isGroup: true,
        chatId: -1001,
        messageId: 700,
        text: "relay one",
        replyToMessageId: 301,
        chain: { chainId: "relay-key-1", turn: 0, humanInitiated: true },
      });
      await publishTelegramGroupRelay({
        sourceAccountId: "knox",
        isGroup: true,
        chatId: -1002,
        messageId: 700,
        text: "relay two",
        replyToMessageId: 302,
        chain: { chainId: "relay-key-2", turn: 0, humanInitiated: true },
      });
    } finally {
      unregisterSource();
      harness.unregisterRelay();
    }

    expect(harness.processCalls).toHaveLength(2);
    const keys = harness.shouldSkipUpdateCalls.map((ctx) => buildTelegramUpdateKey(ctx));
    expect(keys).toEqual(["message:-1001:700", "message:-1002:700"]);
    for (const ctx of harness.shouldSkipUpdateCalls) {
      expect(ctx.update?.update_id).toBeUndefined();
    }
  });

  it("retries getMe identity lookup after transient relay failures", async () => {
    const harness = createRelayHarness({
      getMeImpl: vi
        .fn<() => Promise<UserFromGetMe>>()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue({
          id: 22,
          username: "jade_bot",
          first_name: "Jade",
          is_bot: true,
        } as UserFromGetMe),
    });
    const unregisterSource = registerTelegramGroupRelayEndpoint({
      accountId: "knox",
      resolveIdentity: async () => ({
        botUserId: 11,
        botUsername: "knox_bot",
        botDisplayName: "Knox",
      }),
      handleRelay: async () => {},
    });

    try {
      await publishTelegramGroupRelay({
        sourceAccountId: "knox",
        isGroup: true,
        chatId: -1001,
        messageId: 701,
        text: "@jade_bot first",
        chain: { chainId: "relay-getme-1", turn: 0, humanInitiated: true },
      });
      await publishTelegramGroupRelay({
        sourceAccountId: "knox",
        isGroup: true,
        chatId: -1001,
        messageId: 702,
        text: "@jade_bot second",
        chain: { chainId: "relay-getme-2", turn: 0, humanInitiated: true },
      });
    } finally {
      unregisterSource();
      harness.unregisterRelay();
    }

    expect(harness.getMeMock).toHaveBeenCalledTimes(2);
    expect(harness.processCalls).toHaveLength(1);
    expect(harness.processCalls[0]?.message?.text).toBe("@jade_bot second");
  });

  it("uses a stable synthetic sender id when source identity is unavailable", async () => {
    const harness = createRelayHarness();
    const unregisterSource = registerTelegramGroupRelayEndpoint({
      accountId: "knox",
      resolveIdentity: async () => null,
      handleRelay: async () => {},
    });

    trackTelegramRelayMessageOwner({ chatId: -1001, messageId: 303, accountId: "jade" });
    trackTelegramRelayMessageOwner({ chatId: -1001, messageId: 304, accountId: "jade" });

    try {
      await publishTelegramGroupRelay({
        sourceAccountId: "knox",
        isGroup: true,
        chatId: -1001,
        messageId: 703,
        text: "fallback one",
        replyToMessageId: 303,
        chain: { chainId: "relay-fallback-1", turn: 0, humanInitiated: true },
      });
      await publishTelegramGroupRelay({
        sourceAccountId: "knox",
        isGroup: true,
        chatId: -1001,
        messageId: 704,
        text: "fallback two",
        replyToMessageId: 304,
        chain: { chainId: "relay-fallback-2", turn: 0, humanInitiated: true },
      });
    } finally {
      unregisterSource();
      harness.unregisterRelay();
    }

    expect(harness.processCalls).toHaveLength(2);
    const firstSenderId = harness.processCalls[0]?.message?.from?.id;
    const secondSenderId = harness.processCalls[1]?.message?.from?.id;
    expect(typeof firstSenderId).toBe("number");
    expect(firstSenderId).toBe(secondSenderId);
    expect(firstSenderId).not.toBe(703);
    expect(secondSenderId).not.toBe(704);
    expect(firstSenderId != null && firstSenderId < 0).toBe(true);
  });

  it("does not mirror source text into synthetic reply_to_message text", async () => {
    const harness = createRelayHarness();
    const unregisterSource = registerTelegramGroupRelayEndpoint({
      accountId: "knox",
      resolveIdentity: async () => ({
        botUserId: 11,
        botUsername: "knox_bot",
        botDisplayName: "Knox",
      }),
      handleRelay: async () => {},
    });

    trackTelegramRelayMessageOwner({ chatId: -1001, messageId: 345, accountId: "jade" });

    try {
      await publishTelegramGroupRelay({
        sourceAccountId: "knox",
        isGroup: true,
        chatId: -1001,
        messageId: 705,
        text: "follow-up response",
        replyToMessageId: 345,
        chain: { chainId: "relay-reply-shape", turn: 0, humanInitiated: true },
      });
    } finally {
      unregisterSource();
      harness.unregisterRelay();
    }

    expect(harness.processCalls).toHaveLength(1);
    const relayed = harness.processCalls[0]?.message;
    expect(relayed?.text).toBe("follow-up response");
    expect(relayed?.reply_to_message?.message_id).toBe(345);
    expect(relayed?.reply_to_message?.text).toBeUndefined();
  });
});
