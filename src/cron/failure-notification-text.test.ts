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
    [{ kind: "command-exit", exitCode: 7 } as const, "Cause: command exited with code 7"],
    [{ kind: "command-timeout", mode: "wall-clock" } as const, "Cause: command timed out"],
    [
      { kind: "command-timeout", mode: "no-output" } as const,
      "Cause: command stopped after producing no output",
    ],
  ])("renders closed command detail %#", (detail, expected) => {
    expect(cronFailureDetailLines(undefined, detail)).toEqual([expected]);
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
