import { describe, expect, it } from "vitest";
import {
  type HookDecision,
  type HookDecisionBlock,
  mergeHookDecisions,
  isHookDecision,
  DEFAULT_BLOCK_MESSAGE,
  resolveBlockMessage,
} from "./hook-decision-types.js";

describe("HookDecision helpers", () => {
  describe("isHookDecision", () => {
    it("recognizes supported outcomes", () => {
      expect(isHookDecision({ outcome: "pass" })).toBe(true);
      expect(isHookDecision({ outcome: "ask", reason: "check" })).toBe(true);
      expect(isHookDecision({ outcome: "block", reason: "policy" })).toBe(true);
    });

    it("rejects non-decision values", () => {
      expect(isHookDecision(null)).toBe(false);
      expect(isHookDecision(undefined)).toBe(false);
      expect(isHookDecision("pass")).toBe(false);
      expect(isHookDecision({ block: true })).toBe(false);
      expect(isHookDecision({ outcome: "invalid" })).toBe(false);
    });
  });

  describe("mergeHookDecisions", () => {
    const passDecision: HookDecision = { outcome: "pass" };
    const askDecision: HookDecision = {
      outcome: "ask",
      reason: "needs approval",
      title: "Approval Required",
      description: "Continue with this action?",
    };
    const blockDecision: HookDecision = { outcome: "block", reason: "policy" };

    it("uses most-restrictive-wins ordering", () => {
      expect(mergeHookDecisions(undefined, passDecision)).toBe(passDecision);
      expect(mergeHookDecisions(passDecision, askDecision)).toBe(askDecision);
      expect(mergeHookDecisions(askDecision, passDecision)).toBe(askDecision);
      expect(mergeHookDecisions(askDecision, blockDecision)).toBe(blockDecision);
      expect(mergeHookDecisions(blockDecision, askDecision)).toBe(blockDecision);
      expect(mergeHookDecisions(blockDecision, passDecision)).toBe(blockDecision);
    });

    it("keeps the first decision when outcomes have the same severity", () => {
      const secondAsk: HookDecision = {
        outcome: "ask",
        reason: "second approval",
        title: "Second Check",
        description: "Continue anyway?",
      };
      const secondBlock: HookDecision = { outcome: "block", reason: "second" };

      expect(mergeHookDecisions(passDecision, { outcome: "pass" })).toBe(passDecision);
      expect(mergeHookDecisions(askDecision, secondAsk)).toBe(askDecision);
      expect(mergeHookDecisions(blockDecision, secondBlock)).toBe(blockDecision);
    });
  });

  describe("resolveBlockMessage", () => {
    it("returns explicit or default block messages", () => {
      const explicit: HookDecisionBlock = {
        outcome: "block",
        reason: "policy",
        message: "Please rephrase your request.",
      };
      const fallback: HookDecisionBlock = {
        outcome: "block",
        reason: "policy",
      };

      expect(resolveBlockMessage(explicit)).toBe("Please rephrase your request.");
      expect(resolveBlockMessage(fallback)).toBe(DEFAULT_BLOCK_MESSAGE);
    });
  });
});
