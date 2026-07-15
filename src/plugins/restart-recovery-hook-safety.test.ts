import { beforeEach, describe, expect, it, vi } from "vitest";
import { findRestartRecoveryUnsafeReplyHook } from "./restart-recovery-hook-safety.js";

const hookMocks = vi.hoisted(() => ({
  hasGlobalHooks: vi.fn<(hookName: string) => boolean>(),
}));

vi.mock("./hook-runner-global.js", () => ({
  hasGlobalHooks: hookMocks.hasGlobalHooks,
}));

describe("findRestartRecoveryUnsafeReplyHook", () => {
  beforeEach(() => {
    hookMocks.hasGlobalHooks.mockReset();
    hookMocks.hasGlobalHooks.mockReturnValue(false);
  });

  it("reports the first active unsafe reply hook", () => {
    hookMocks.hasGlobalHooks.mockImplementation(
      (hookName) => hookName === "before_agent_reply" || hookName === "before_message_write",
    );

    expect(findRestartRecoveryUnsafeReplyHook()).toBe("before_agent_reply");
  });

  it("exempts checkpointed before_agent_reply but not another active hook", () => {
    hookMocks.hasGlobalHooks.mockImplementation(
      (hookName) => hookName === "before_agent_reply" || hookName === "before_message_write",
    );

    expect(findRestartRecoveryUnsafeReplyHook({ allowBeforeAgentReply: true })).toBe(
      "before_message_write",
    );
  });
});
