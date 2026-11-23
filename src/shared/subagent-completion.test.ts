import { describe, expect, it } from "vitest";
import { subagentCompletionForOutcome } from "./subagent-completion.js";

describe("subagentCompletionForOutcome", () => {
  const child = { runId: "run-1", sessionKey: "agent:main:subagent:a", label: "Atlas" };

  it("records how an announced child ended, so a failure keeps its own row", () => {
    expect(subagentCompletionForOutcome(child, "ok")).toEqual(child);
    expect(subagentCompletionForOutcome(child, "timeout")).toEqual({
      ...child,
      outcome: "timeout",
    });
    expect(subagentCompletionForOutcome(child, "error")).toEqual({ ...child, outcome: "failed" });
    expect(subagentCompletionForOutcome(child, "ok", true)).toEqual({
      ...child,
      outcome: "killed",
    });
    expect(subagentCompletionForOutcome(child, "unknown")).toBeUndefined();
  });
});
