import { describe, expect, it } from "vitest";
import {
  deriveTelegramLiveRuntimeProfile,
  selectTelegramTesterToken,
} from "../../scripts/lib/telegram-live-runtime-helpers.mjs";

describe("telegram-live-runtime-helpers", () => {
  it("derives deterministic per-worktree runtime profile", () => {
    const first = deriveTelegramLiveRuntimeProfile({ worktreePath: "/tmp/openclaw/worktree-a" });
    const second = deriveTelegramLiveRuntimeProfile({ worktreePath: "/tmp/openclaw/worktree-a" });
    const third = deriveTelegramLiveRuntimeProfile({ worktreePath: "/tmp/openclaw/worktree-b" });

    expect(first).toEqual(second);
    expect(first.profileId).not.toBe(third.profileId);
    expect(first.runtimePort).not.toBe(18789);
    expect(first.runtimePort).toBeGreaterThanOrEqual(20000);
    expect(first.runtimePort).toBeLessThan(30000);
  });

  it("retains current token when valid and unclaimed by other worktrees", () => {
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

  it("reassigns token when current token is invalid/conflicting", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["token-a", "token-b", "token-c"],
      claimedTokens: ["token-a", "token-b"],
      currentToken: "token-a",
    });

    expect(result).toEqual({
      ok: true,
      action: "assign",
      reason: "reassign_conflict_or_invalid",
      selectedToken: "token-c",
    });
  });

  it("fails hard when no tester token is available", () => {
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
