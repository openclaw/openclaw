import { describe, expect, it, vi } from "vitest";

import { buildTelegramMessageContext } from "./bot-message-context.js";

describe("buildTelegramMessageContext sender prefix", () => {
  it("prefixes group bodies with sender label", async () => {
    const ctx = await buildTelegramMessageContext({
      primaryCtx: {
        message: {
          message_id: 1,
          chat: { id: -99, type: "supergroup", title: "Dev Chat" },
          date: 1700000000,
          text: "hello",
          from: { id: 42, first_name: "Alice" },
        },
        me: { id: 7, username: "bot" },
      } as never,
      allMedia: [],
      storeAllowFrom: [],
      options: {},
      bot: {
        api: {
          sendChatAction: vi.fn(),
          setMessageReaction: vi.fn(),
        },
      } as never,
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/clawd" } },
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: [] } },
      } as never,
      account: { accountId: "default" } as never,
      historyLimit: 0,
      groupHistories: new Map(),
      dmPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      ackReactionScope: "off",
      logger: { info: vi.fn() },
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx).not.toBeNull();
    const body = ctx?.ctxPayload?.Body ?? "";
    expect(body).toContain("Alice (42): hello");
  });
});
