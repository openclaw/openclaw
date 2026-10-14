import { describe, expect, it } from "vitest";
import { assertPrecheckSupport } from "./jobs-validation.js";

describe("assertPrecheckSupport", () => {
  it("rejects overlapping work and no-work exit codes before persistence", () => {
    expect(() =>
      assertPrecheckSupport({
        precheck: {
          kind: "exec",
          command: "echo hi",
          workExitCodes: [0, 2],
          noWorkExitCodes: [2],
        },
      }),
    ).toThrow(/must not overlap|invalid/i);
  });

  it("rejects blank command before persistence", () => {
    expect(() =>
      assertPrecheckSupport({
        precheck: {
          kind: "exec",
          command: "   ",
        },
      }),
    ).toThrow(/non-empty command/i);
  });

  it("accepts a valid precheck when triggers are enabled", () => {
    expect(() =>
      assertPrecheckSupport(
        {
          precheck: {
            kind: "exec",
            command: "echo NO_WORK; exit 2",
            noWorkExitCodes: [2],
            workExitCodes: [0],
          },
        },
        { cronConfig: { triggers: { enabled: true } }, requireEnabled: true },
      ),
    ).not.toThrow();
  });
});
