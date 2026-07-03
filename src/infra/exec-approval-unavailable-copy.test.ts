// Tests copy selection for unavailable optional exec approval actions.
import { describe, expect, it } from "vitest";
import {
  resolveExecApprovalAllowAlwaysUnavailableReason,
  resolveExecApprovalAllowAlwaysUnavailableText,
} from "./exec-approval-unavailable-copy.js";

describe("exec approval allow-always unavailable copy", () => {
  it("keeps ask=always attributed to the effective approval policy", () => {
    expect(
      resolveExecApprovalAllowAlwaysUnavailableReason({
        ask: "always",
      }),
    ).toBe("policy-ask-always");
    expect(
      resolveExecApprovalAllowAlwaysUnavailableText({
        ask: "always",
      }),
    ).toBe(
      "The effective approval policy requires approval every time, so Allow Always is unavailable.",
    );
  });

  it("keeps ask=always policy copy ahead of stale explicit reasons", () => {
    expect(
      resolveExecApprovalAllowAlwaysUnavailableReason({
        ask: "always",
        unavailableDecisions: ["allow-always"],
        allowAlwaysUnavailableReason: "one-shot-command",
      }),
    ).toBe("policy-ask-always");
  });

  it("attributes allow-always removal to one-shot command persistence when policy is not ask=always", () => {
    expect(
      resolveExecApprovalAllowAlwaysUnavailableReason({
        ask: "on-miss",
        unavailableDecisions: ["allow-always"],
      }),
    ).toBe("one-shot-command");
    expect(
      resolveExecApprovalAllowAlwaysUnavailableText({
        ask: "on-miss",
        unavailableDecisions: ["allow-always"],
      }),
    ).toBe(
      "Allow Always is unavailable because this command is one-shot and cannot be saved as a reusable approval.",
    );
  });

  it("does not show unavailable copy when allow-always is available", () => {
    expect(
      resolveExecApprovalAllowAlwaysUnavailableText({
        ask: "on-miss",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      }),
    ).toBeNull();
  });
});
