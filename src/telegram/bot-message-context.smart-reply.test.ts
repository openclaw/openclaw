import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContext } from "./bot-message-context.js";

describe("buildTelegramMessageContext Smart Reply", () => {
  it("injects smart reply system prompt when activationMode is auto", async () => {
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
      options: {
        activationMode: "auto",
      },
      bot: {
        api: {
          sendChatAction: vi.fn(),
          setMessageReaction: vi.fn(),
        },
      } as never,
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
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
    const prompt = ctx?.ctxPayload?.GroupSystemPrompt;
    expect(prompt).toContain("You are in Smart Reply Mode");
    expect(prompt).toContain("[NO_REPLY]");
  });

  it("does not inject smart reply system prompt when activationMode is not auto", async () => {
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
      options: {
        activationMode: "mention",
      },
      bot: {
        api: {
          sendChatAction: vi.fn(),
          setMessageReaction: vi.fn(),
        },
      } as never,
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
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
    const prompt = ctx?.ctxPayload?.GroupSystemPrompt;
    expect(prompt).toBeUndefined();
  });
});
