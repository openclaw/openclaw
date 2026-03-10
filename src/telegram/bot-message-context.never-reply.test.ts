import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../auto-reply/reply/history.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveTelegramInboundBody } from "./bot-message-context.body.js";

describe("resolveTelegramInboundBody neverReply", () => {
  const WILDCARD_ALLOW = {
    entries: ["*"],
    hasWildcard: true,
    hasEntries: true,
    invalidEntries: [],
  };

  function makeParams(overrides: {
    neverReply: boolean;
    historyLimit: number;
    groupHistories: Map<string, HistoryEntry[]>;
  }) {
    return {
      cfg: {
        channels: { telegram: { neverReply: overrides.neverReply } },
        messages: { groupChat: { mentionPatterns: [] } },
      } as unknown as OpenClawConfig,
      accountId: "default",
      primaryCtx: {
        me: { id: 7, username: "bot" },
      } as never,
      msg: {
        message_id: 1,
        date: 1_700_000_000,
        text: "hello group",
        from: { id: 42, first_name: "Alice", username: "alice" },
        chat: { id: -100555, type: "supergroup", title: "Silent Group" },
      } as never,
      allMedia: [],
      isGroup: true,
      chatId: -100555 as number | string,
      senderId: "42",
      senderUsername: "alice",
      effectiveGroupAllow: WILDCARD_ALLOW,
      effectiveDmAllow: WILDCARD_ALLOW,
      groupConfig: { requireMention: false },
      requireMention: false,
      options: {},
      groupHistories: overrides.groupHistories,
      historyLimit: overrides.historyLimit,
      logger: { info: () => {} } as never,
    };
  }

  it("returns null and records history when neverReply is true", async () => {
    const groupHistories = new Map<string, HistoryEntry[]>();

    const result = await resolveTelegramInboundBody(
      makeParams({ neverReply: true, historyLimit: 10, groupHistories }),
    );

    expect(result).toBeNull();

    const entries = groupHistories.get("-100555");
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({
      sender: "Alice (@alice) id:42",
      body: "hello group",
    });
  });

  it("does not drop when neverReply is false", async () => {
    const groupHistories = new Map<string, HistoryEntry[]>();

    const result = await resolveTelegramInboundBody(
      makeParams({ neverReply: false, historyLimit: 10, groupHistories }),
    );

    expect(result).not.toBeNull();
    expect(groupHistories.size).toBe(0);
  });
});
