import { describe, expect, it } from "vitest";
import { appendExecDenialGuidance } from "./invoke-system-run-denied.js";

const APPROVAL_GUIDANCE =
  "Do not attempt the same outcome through a workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or ask the user to approve this exact command after explaining the risk.";
const POLICY_GUIDANCE =
  "Execution is disabled by policy. Do not attempt to bypass or work around this restriction. Ask the operator to change the exec security policy if this command is required.";

describe("appendExecDenialGuidance", () => {
  it.each([
    {
      reason: "allowlist-miss",
      message: "SYSTEM_RUN_DENIED: allowlist miss",
      guidance: APPROVAL_GUIDANCE,
    },
    {
      reason: "security=deny",
      message: "SYSTEM_RUN_DISABLED: security=deny",
      guidance: POLICY_GUIDANCE,
    },
  ] as const)("adds class-appropriate guidance to $reason denials", (testCase) => {
    expect(appendExecDenialGuidance(testCase.message, testCase.reason)).toBe(
      `${testCase.message}\n${testCase.guidance}`,
    );
  });

  it("preserves unrelated native denials", () => {
    const message = "Working directory does not exist, is inaccessible, or is not a directory.";
    expect(appendExecDenialGuidance(message, "cwd-unavailable")).toBe(message);
  });

  it("does not duplicate guidance already provided by the native evaluator", () => {
    const message = `SYSTEM_RUN_DENIED: allowlist miss\n${APPROVAL_GUIDANCE}`;
    expect(appendExecDenialGuidance(message, "allowlist-miss")).toBe(message);
  });
});
