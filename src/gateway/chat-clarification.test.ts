import { describe, expect, it } from "vitest";
import { evaluateChatClarification } from "./chat-clarification.js";

describe("chat clarification gate", () => {
  it("asks for detail before vague task prompts start an agent run", () => {
    const decision = evaluateChatClarification({ message: "fix this" });

    expect(decision.action).toBe("clarify");
    if (decision.action === "clarify") {
      expect(decision.clarification.question).toContain("What exactly should I work on");
      expect(decision.clarification.issues.map((issue) => issue.key)).toEqual([
        "too_short",
        "vague_reference",
        "missing_context",
        "missing_outcome",
      ]);
    }
  });

  it("lets contextual approvals continue in an existing session", () => {
    expect(
      evaluateChatClarification({
        message: "Perfect, please implement",
        hasPriorSessionContext: true,
      }).action,
    ).toBe("execute");
  });

  it("asks for boundaries before risky underspecified actions", () => {
    const decision = evaluateChatClarification({ message: "delete the old stuff" });

    expect(decision.action).toBe("clarify");
    if (decision.action === "clarify") {
      expect(decision.clarification.issues.map((issue) => issue.key)).toContain("risky_action");
      expect(decision.clarification.question).toContain("potentially destructive");
    }
  });

  it("lets concrete prompts and direct commands pass through", () => {
    expect(
      evaluateChatClarification({
        message:
          "Implement prompt filtering in ui/src/ui/views/chat.ts, run focused tests, and summarize what changed.",
      }).action,
    ).toBe("execute");
    expect(evaluateChatClarification({ message: "/status" }).action).toBe("execute");
  });

  it("does not block system-originated sends or explicit bypasses", () => {
    expect(evaluateChatClarification({ message: "fix this", isSystemOrigin: true }).action).toBe(
      "execute",
    );
    expect(evaluateChatClarification({ message: "fix this", bypass: true }).action).toBe("execute");
  });
});
