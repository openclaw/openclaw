import { describe, expect, it, vi } from "vitest";
import { resolveChannelGroupRequireMention } from "../config/group-policy.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("Issue #33218: groupPolicy='open' should not require mention (INTEGRATION TEST)", () => {
  it("✅ FIXED: groupPolicy='open' allows messages WITHOUT @mention to be processed", async () => {
    const logger = { info: vi.fn() };

    const cfg = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
      channels: {
        telegram: {
          enabled: true,
          groupPolicy: "open", // ← User configured "open" policy
          // No requireMention configured
        },
      },
      messages: { groupChat: { mentionPatterns: [] } },
    };

    // Simulate a Telegram group message WITHOUT @mention
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 100,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        date: 1700000000,
        text: "hello everyone", // ← NO @mention
        from: { id: 42, first_name: "Alice" },
      },
      cfg,
      logger,
      // Use the REAL resolveChannelGroupRequireMention function (now fixed)
      resolveGroupRequireMention: (chatId) => {
        const result = resolveChannelGroupRequireMention({
          cfg: cfg as never,
          channel: "telegram",
          groupId: String(chatId),
        });
        console.log(`  resolveChannelGroupRequireMention(${chatId}) = ${result}`);
        return result;
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined, // No explicit group config
        topicConfig: undefined,
      }),
    });

    console.log("✅ FIX VERIFIED (INTEGRATION TEST):");
    console.log(`  Config: groupPolicy="open", no requireMention`);
    console.log(`  Message: "hello everyone" (NO @mention) in group chat`);
    console.log(
      `  Result: ctx = ${ctx === null ? "null (message SKIPPED)" : "not null (message PROCESSED ✅)"}`,
    );

    // After fix: message should be processed (ctx is not null)
    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.Body).toContain("hello everyone");
    console.log("  ✅ FIX VERIFIED: Message was processed with groupPolicy='open'");
  });

  it("groupPolicy='allowlist' should still require mention and skip messages without @mention", async () => {
    const logger = { info: vi.fn() };

    const cfg = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
      channels: {
        telegram: {
          enabled: true,
          groupPolicy: "allowlist", // allowlist should require mention
        },
      },
      messages: { groupChat: { mentionPatterns: [] } },
    };

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 100,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        date: 1700000000,
        text: "hello without mention",
        from: { id: 42, first_name: "Alice" },
      },
      cfg,
      logger,
      resolveGroupRequireMention: (chatId) => {
        return resolveChannelGroupRequireMention({
          cfg: cfg as never,
          channel: "telegram",
          groupId: String(chatId),
        });
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
    });

    // allowlist should still skip messages without mention
    expect(ctx).toBeNull();
  });

  it("groupPolicy='open' with explicit @mention should also be processed", async () => {
    const logger = { info: vi.fn() };

    const cfg = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
      channels: {
        telegram: {
          enabled: true,
          groupPolicy: "open",
        },
      },
      messages: { groupChat: { mentionPatterns: [] } },
    };

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 100,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        date: 1700000000,
        text: "@bot hello",
        from: { id: 42, first_name: "Alice" },
      },
      cfg,
      logger,
      resolveGroupRequireMention: (chatId) => {
        return resolveChannelGroupRequireMention({
          cfg: cfg as never,
          channel: "telegram",
          groupId: String(chatId),
        });
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
    });

    // With @mention, message should definitely be processed
    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });
});
