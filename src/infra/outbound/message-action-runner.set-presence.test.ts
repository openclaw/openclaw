import { describe, expect, it, vi } from "vitest";
import { applyTargetToParams } from "./channel-target.js";
import { MESSAGE_ACTION_TARGET_MODE, actionRequiresTarget } from "./message-action-spec.js";

/**
 * Test to reproduce and verify fix for Issue #6040:
 * Discord set-presence action broken when called from agent context
 *
 * The bug: When message tool is called from a Discord session context,
 * the current channel/DM is automatically injected as `target`.
 * For actions with mode "none" (like set-presence), this causes:
 * "Action set-presence does not accept a target."
 */
describe("Issue #6040: set-presence target injection bug", () => {
  describe("MESSAGE_ACTION_TARGET_MODE", () => {
    it("should have set-presence defined with mode 'none'", () => {
      // Before fix: set-presence was not in MESSAGE_ACTION_TARGET_MODE
      // After fix: set-presence should be defined with mode "none"
      expect(MESSAGE_ACTION_TARGET_MODE["set-presence"]).toBe("none");
    });

    it("should report set-presence does not require target", () => {
      // Before fix: actionRequiresTarget would return false (undefined ?? "none" === "none")
      // but the action wasn't properly registered
      expect(actionRequiresTarget("set-presence")).toBe(false);
    });
  });

  describe("applyTargetToParams", () => {
    it("should NOT throw when set-presence is called without target", () => {
      // This is the expected use case - agent calls set-presence without target
      const params = {
        action: "set-presence",
        args: {
          type: "playing",
          name: "My Status",
          status: "online",
        },
      };

      // Should not throw
      expect(() => applyTargetToParams(params)).not.toThrow();
    });

    it("should throw when set-presence is called WITH target (the bug scenario)", () => {
      // This reproduces the bug: target is auto-injected by the system
      // when called from a Discord session context
      const params = {
        action: "set-presence",
        args: {
          target: "channel:123456789", // Auto-injected by system
          type: "playing",
          name: "My Status",
          status: "online",
        },
      };

      // The fix ensures this throws the expected error
      // (which is correct - set-presence should not accept a target)
      expect(() => applyTargetToParams(params)).toThrow(
        "Action set-presence does not accept a target.",
      );
    });

    it("should NOT throw for actions that accept target", () => {
      const params = {
        action: "send",
        args: {
          target: "channel:123456789",
          message: "Hello",
        } as Record<string, unknown>,
      };

      // Should not throw - send accepts target
      expect(() => applyTargetToParams(params)).not.toThrow();
      expect(params.args.to).toBe("channel:123456789");
    });
  });

  describe("Integration: simulating agent context call", () => {
    it("should allow set-presence when target is not injected", () => {
      // Simulate the fix: don't inject target for actions with mode "none"
      const action = "set-presence";
      const mode = MESSAGE_ACTION_TARGET_MODE[action];

      // The fix: check mode before injecting target
      const shouldInjectTarget = mode !== "none";
      expect(shouldInjectTarget).toBe(false);

      // So target should NOT be injected for set-presence
      const params = {
        action,
        args: {
          type: "playing",
          name: "Bill's Personal Assistant",
          status: "online",
        },
      };

      // Without target injection, applyTargetToParams should succeed
      expect(() => applyTargetToParams(params)).not.toThrow();
    });
  });
});
