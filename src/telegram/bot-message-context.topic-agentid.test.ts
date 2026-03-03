import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext per-topic agentId routing", () => {
  it("uses group-level agent when no topic agentId is set", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum",
          is_forum: true,
        },
        date: 1700000000,
        text: "@bot hello",
        message_thread_id: 3,
        from: { id: 42, first_name: "Alice" },
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { systemPrompt: "Be nice" },
      }),
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:3");
  });

  it("routes to topic-specific agent when agentId is set", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum",
          is_forum: true,
        },
        date: 1700000000,
        text: "@bot hello",
        message_thread_id: 3,
        from: { id: 42, first_name: "Alice" },
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { agentId: "zu", systemPrompt: "I am Zu" },
      }),
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:zu:");
    expect(ctx?.ctxPayload?.SessionKey).toContain("telegram:group:-1001234567890:topic:3");
  });

  it("different topics route to different agents", async () => {
    const buildForTopic = async (threadId: number, agentId: string) =>
      await buildTelegramMessageContextForTest({
        message: {
          message_id: 1,
          chat: {
            id: -1001234567890,
            type: "supergroup",
            title: "Forum",
            is_forum: true,
          },
          date: 1700000000,
          text: "@bot hello",
          message_thread_id: threadId,
          from: { id: 42, first_name: "Alice" },
        },
        options: { forceWasMentioned: true },
        resolveGroupActivation: () => true,
        resolveTelegramGroupConfig: () => ({
          groupConfig: { requireMention: false },
          topicConfig: { agentId },
        }),
      });

    const ctxA = await buildForTopic(1, "main");
    const ctxB = await buildForTopic(3, "zu");
    const ctxC = await buildForTopic(5, "q");

    expect(ctxA?.ctxPayload?.SessionKey).toContain("agent:main:");
    expect(ctxB?.ctxPayload?.SessionKey).toContain("agent:zu:");
    expect(ctxC?.ctxPayload?.SessionKey).toContain("agent:q:");

    expect(ctxA?.ctxPayload?.SessionKey).not.toBe(ctxB?.ctxPayload?.SessionKey);
    expect(ctxB?.ctxPayload?.SessionKey).not.toBe(ctxC?.ctxPayload?.SessionKey);
  });

  it("ignores whitespace-only agentId and uses group-level agent", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum",
          is_forum: true,
        },
        date: 1700000000,
        text: "@bot hello",
        message_thread_id: 3,
        from: { id: 42, first_name: "Alice" },
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { agentId: "   ", systemPrompt: "Be nice" },
      }),
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:main:");
  });

  it("routes DM topic to specific agent when agentId is set", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: {
          id: 123456789,
          type: "private",
        },
        date: 1700000000,
        text: "@bot hello",
        message_thread_id: 99,
        from: { id: 42, first_name: "Alice" },
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { agentId: "support", systemPrompt: "I am support" },
      }),
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:support:");
  });
});
