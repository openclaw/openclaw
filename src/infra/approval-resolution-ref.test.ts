// Approval transport reference tests cover deterministic, kind-bound locators.
import { describe, expect, it } from "vitest";
import { buildApprovalResolutionRef, isApprovalResolutionRef } from "./approval-resolution-ref.js";

describe("approval resolution references", () => {
  it("binds the locator to the exact id and owner kind", () => {
    const execRef = buildApprovalResolutionRef({ approvalId: "same-id", approvalKind: "exec" });
    expect(buildApprovalResolutionRef({ approvalId: "same-id", approvalKind: "plugin" })).not.toBe(
      execRef,
    );
    expect(buildApprovalResolutionRef({ approvalId: "same-id ", approvalKind: "exec" })).not.toBe(
      execRef,
    );
  });

  it.each(["", "a".repeat(42), "a".repeat(44), "!".repeat(43)])(
    "rejects malformed transport references %#",
    (value) => {
      expect(isApprovalResolutionRef(value)).toBe(false);
    },
  );
});
