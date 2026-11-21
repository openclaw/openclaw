import { describe, expect, it } from "vitest";
import { FAILOVER_REASONS } from "../agents/failover/signal.js";
import { cronFailureDetailLines } from "./failure-notification-text.js";

describe("cronFailureDetailLines", () => {
  it("prefers a classified failure over producer-authored detail", () => {
    expect(cronFailureDetailLines("timeout", { kind: "command-exit", exitCode: 7 })).toEqual([
      "Cause: the AI provider took too long to answer.",
    ]);
  });

  it.each(FAILOVER_REASONS)("says %s in plain words, never as its code, and no CLI", (reason) => {
    const [line] = cronFailureDetailLines(reason);
    expect(line).toMatch(/^Cause: /);
    expect(line).not.toContain(`Cause: ${reason}`);
    expect(line).not.toContain("_");
    expect(line).not.toContain("openclaw ");
  });

  it.each([
    [{ kind: "command-exit", exitCode: 7 } as const, "Cause: its command exited with code 7."],
    [
      { kind: "agent-stall", classification: "blocked_tool_call" } as const,
      "Cause: the run waited on a tool call that could not continue, so it stopped.",
    ],
    [
      { kind: "agent-stall", classification: "other_cause" } as const,
      "Cause: the run became stuck, so it stopped.",
    ],
    [
      { kind: "invalid-target" } as const,
      "Cause: the agent or conversation it runs in no longer exists.",
    ],
    [
      { kind: "script-failure", source: "trigger", code: "script_error" } as const,
      "Cause: the trigger script stopped with an error. The run history has its message.",
    ],
    [
      { kind: "script-failure", source: "payload", code: "timeout" } as const,
      "Cause: the automation script took too long, so it stopped.",
    ],
  ])("renders closed producer detail %#", (detail, expected) => {
    expect(cronFailureDetailLines(undefined, detail)).toEqual([expected]);
  });

  it("uses the generic fallback without a classified or producer-authored fact", () => {
    expect(cronFailureDetailLines(undefined)).toEqual([
      "Cause: not recorded. The automation's run history has the details.",
    ]);
  });
});
