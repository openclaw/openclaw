import { describe, expect, it } from "vitest";
import { cronFailureDetailLines } from "./failure-notification-text.js";

const GENERIC_DETAIL = "Check automation history for details.";

describe("cronFailureDetailLines", () => {
  it("prefers a classified failure over producer-authored detail", () => {
    expect(cronFailureDetailLines("timeout", { kind: "command-exit", exitCode: 7 })).toEqual([
      "Cause: timeout",
    ]);
  });

  it("explains how to repair an unsupported model selection", () => {
    expect(cronFailureDetailLines("model_not_found")).toEqual([
      "Cause: model_not_found",
      "Run `openclaw doctor --fix` to repair provider-declared retired model references.",
      "Choose a supported model for this automation or remove its model override to use the agent default. If the agent default is unavailable, update it too.",
    ]);
  });

  it.each([
    [
      "route_unavailable",
      "The provider cannot serve this model right now. Choose another model for this automation or ask the provider operator to restore the route, then run it again.",
    ],
    [
      "billing",
      "Ask the provider account owner to resolve the billing error, or choose another provider for this automation, then run it again.",
    ],
    [
      "server_error",
      "The AI service is having trouble. Wait a moment and run the automation again, or choose another provider.",
    ],
  ] as const)("gives %s failures an actionable recovery step", (reason, guidance) => {
    expect(cronFailureDetailLines(reason)).toEqual([`Cause: ${reason}`, guidance]);
  });

  it.each([
    [{ kind: "command-exit", exitCode: 7 } as const, ["Cause: command exited with code 7"]],
    [{ kind: "command-timeout", mode: "wall-clock" } as const, ["Cause: command timed out"]],
    [
      { kind: "command-timeout", mode: "no-output" } as const,
      ["Cause: command stopped after producing no output"],
    ],
    [
      { kind: "agent-stall", classification: "blocked_tool_call" } as const,
      [
        "Cause: blocked_tool_call",
        "The agent was blocked waiting on a tool call that made no progress.",
        "Review the tool's permissions and any blocked invocation, then rerun the automation.",
      ],
    ],
    [
      { kind: "agent-stall", classification: "other_cause" } as const,
      [
        "Cause: other_cause",
        "The agent run was stopped because its session became stuck.",
        "Check the automation history for details, then rerun if appropriate.",
      ],
    ],
  ])("renders closed producer detail %#", (detail, expected) => {
    expect(cronFailureDetailLines(undefined, detail)).toEqual(expected);
  });

  it("labels script failures by their producer", () => {
    expect(
      cronFailureDetailLines(undefined, {
        kind: "script-failure",
        source: "payload",
        code: "timeout",
      }),
    ).toEqual(["Cause: automation script timed out"]);
    expect(
      cronFailureDetailLines(undefined, {
        kind: "script-failure",
        source: "trigger",
        code: "timeout",
      }),
    ).toEqual(["Cause: trigger script timed out"]);
  });

  it("uses the generic fallback without a classified or producer-authored fact", () => {
    expect(cronFailureDetailLines(undefined)).toEqual([GENERIC_DETAIL]);
  });
});
