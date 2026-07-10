import { describe, expect, it } from "vitest";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  resolveRequiredCompletionTerminalResult,
} from "./task-completion-contract.js";

describe("task-completion-contract", () => {
  it("keeps the bounded failure reason UTF-16 well-formed", () => {
    const result = resolveRequiredCompletionDeliveryFailureTerminalResult(
      `${"x".repeat(158)}🚀tail`,
    );

    expect(result.terminalSummary).toContain(`${"x".repeat(158)}...`);
    expect(result.terminalSummary).not.toContain("\uD83D");
  });

  it("marks structured blocked completion reports as blocked", () => {
    const result = resolveRequiredCompletionTerminalResult(
      [
        "Diagnosed the request but cannot continue safely.",
        "",
        "state: blocked",
        "human_action_required: true",
        "human_action_summary: Approve the protected config change.",
      ].join("\n"),
    );

    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toContain("Required completion reported a blocker:");
  });

  it("marks markdown blocker reports as blocked", () => {
    const result = resolveRequiredCompletionTerminalResult(
      "- **Blocker/next action:** User must approve updating gateway auth settings.",
    );

    expect(result.terminalOutcome).toBe("blocked");
  });

  it("does not treat ordinary final output or no-blocker text as blocked", () => {
    expect(
      resolveRequiredCompletionTerminalResult(
        "Fixed the issue and verified tests pass. No blockers.",
      ),
    ).toEqual({});
  });
});
