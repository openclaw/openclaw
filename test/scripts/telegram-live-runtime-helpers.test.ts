import { describe, expect, it } from "vitest";
import {
  clearEnvAssignmentText,
  deriveTelegramLiveRuntimeProfile,
  pruneTelegramThreadSessions,
  selectTelegramTesterToken,
} from "../../scripts/lib/telegram-live-runtime-helpers.mjs";

describe("deriveTelegramLiveRuntimeProfile", () => {
  it("returns stable deterministic profile fields for the same worktree path", () => {
    const worktreePath = "/tmp/openclaw/worktrees/runtime-a";
    const first = deriveTelegramLiveRuntimeProfile({ worktreePath });
    const second = deriveTelegramLiveRuntimeProfile({ worktreePath });

    expect(second).toEqual(first);
    expect(first.profileId).toMatch(/^tg-live-[a-f0-9]{10}$/);
    expect(first.runtimePort).toBeGreaterThanOrEqual(20000);
    expect(first.runtimePort).toBeLessThan(30000);
    expect(first.runtimePort).not.toBe(18789);
  });

  it("produces different profile IDs for different worktree paths", () => {
    const a = deriveTelegramLiveRuntimeProfile({ worktreePath: "/tmp/openclaw/worktrees/a" });
    const b = deriveTelegramLiveRuntimeProfile({ worktreePath: "/tmp/openclaw/worktrees/b" });

    expect(a.profileId).not.toBe(b.profileId);
  });
});

describe("selectTelegramTesterToken", () => {
  it("retains the current worktree token when it remains available", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["token-a", "token-b", "token-c"],
      claimedTokens: ["token-b"],
      currentToken: "token-a",
    });

    expect(result).toEqual({
      ok: true,
      action: "retain",
      reason: "current_available",
      selectedToken: "token-a",
    });
  });

  it("reassigns when current token is conflicting or invalid", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["token-a", "token-b", "token-c"],
      claimedTokens: ["token-b", "token-c"],
      currentToken: "token-b",
    });

    expect(result).toEqual({
      ok: true,
      action: "assign",
      reason: "reassign_conflict_or_invalid",
      selectedToken: "token-a",
    });
  });

  it("hard-fails when the tester pool is exhausted", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["token-a", "token-b"],
      claimedTokens: ["token-a", "token-b"],
      currentToken: "",
    });

    expect(result).toEqual({
      ok: false,
      action: "fail",
      reason: "pool_exhausted",
      selectedToken: null,
    });
  });
});

describe("clearEnvAssignmentText", () => {
  it("removes all matching assignments while preserving unrelated env entries", () => {
    const result = clearEnvAssignmentText({
      key: "TELEGRAM_BOT_TOKEN",
      content: [
        "OPENAI_API_KEY=abc",
        "TELEGRAM_BOT_TOKEN=token-a",
        "export TELEGRAM_BOT_TOKEN='token-b'",
        "OTHER_FLAG=1",
        "",
      ].join("\n"),
    });

    expect(result).toEqual({
      content: ["OPENAI_API_KEY=abc", "OTHER_FLAG=1", ""].join("\n"),
      removed: true,
      removedValue: "token-b",
    });
  });

  it("keeps content unchanged when the assignment is absent", () => {
    const content = ["OPENAI_API_KEY=abc", "OTHER_FLAG=1", ""].join("\n");
    const result = clearEnvAssignmentText({
      key: "TELEGRAM_BOT_TOKEN",
      content,
    });

    expect(result).toEqual({
      content,
      removed: false,
      removedValue: "",
    });
  });

  it("preserves newline style when clearing a token assignment", () => {
    const result = clearEnvAssignmentText({
      key: "TELEGRAM_BOT_TOKEN",
      content: 'OPENAI_API_KEY=abc\r\nTELEGRAM_BOT_TOKEN="token-a"\r\n',
    });

    expect(result).toEqual({
      content: "OPENAI_API_KEY=abc\r\n",
      removed: true,
      removedValue: "token-a",
    });
  });
});

describe("pruneTelegramThreadSessions", () => {
  it("removes only the targeted forum topic session and keeps future-thread defaults", () => {
    const result = pruneTelegramThreadSessions({
      agentId: "main",
      chatId: "-1003841996303",
      threadId: 4,
      sessions: {
        "agent:main:telegram:group:-1003841996303:topic:4": {
          channel: "telegram",
          groupId: "-1003841996303:topic:4",
          deliveryContext: { channel: "telegram", to: "telegram:-1003841996303", threadId: 4 },
          origin: {
            provider: "telegram",
            from: "telegram:group:-1003841996303:topic:4",
            threadId: 4,
          },
        },
        "agent:main:telegram:group:-1003841996303": {
          futureThreadProviderOverride: "anthropic",
          futureThreadModelOverride: "claude-sonnet-4-6",
        },
        "agent:main:telegram:group:-1003841996303:topic:3": {
          channel: "telegram",
          groupId: "-1003841996303:topic:3",
          deliveryContext: { channel: "telegram", to: "telegram:-1003841996303", threadId: 3 },
          origin: {
            provider: "telegram",
            from: "telegram:group:-1003841996303:topic:3",
            threadId: 3,
          },
        },
      },
    });

    expect(result.removedKeys).toEqual(["agent:main:telegram:group:-1003841996303:topic:4"]);
    expect(result.sessions["agent:main:telegram:group:-1003841996303"]).toBeDefined();
    expect(result.sessions["agent:main:telegram:group:-1003841996303:topic:3"]).toBeDefined();
    expect(result.sessions["agent:main:telegram:group:-1003841996303:topic:4"]).toBeUndefined();
  });

  it("removes only the targeted DM thread session", () => {
    const result = pruneTelegramThreadSessions({
      agentId: "main",
      chatId: "1336356696",
      threadId: 38563,
      sessions: {
        "agent:main:telegram:default:direct:1336356696:thread:1336356696:38563": {
          deliveryContext: { channel: "telegram", to: "telegram:1336356696", threadId: 38563 },
          origin: {
            provider: "telegram",
            from: "telegram:1336356696",
            to: "telegram:1336356696",
            threadId: 38563,
          },
        },
        "agent:main:telegram:default:direct:1336356696:thread:1336356696:38478": {
          deliveryContext: { channel: "telegram", to: "telegram:1336356696", threadId: 38478 },
          origin: {
            provider: "telegram",
            from: "telegram:1336356696",
            to: "telegram:1336356696",
            threadId: 38478,
          },
        },
      },
    });

    expect(result.removedKeys).toEqual([
      "agent:main:telegram:default:direct:1336356696:thread:1336356696:38563",
    ]);
    expect(
      result.sessions["agent:main:telegram:default:direct:1336356696:thread:1336356696:38478"],
    ).toBeDefined();
  });
});
