import { describe, expect, it } from "vitest";
import {
  evaluateActionSinkPolicy,
  policyResult,
  summarizePolicyPayload,
} from "./action-sink-policy.js";

describe("action sink policy kernel", () => {
  const request = { policyVersion: "v1", actionType: "file_write" as const, correlationId: "c1" };

  it("serializes allow/block/requireApproval decisions", () => {
    expect(policyResult({ decision: "allow", reasonCode: "allowed", reason: "ok" }).decision).toBe(
      "allow",
    );
    expect(
      policyResult({ decision: "block", reasonCode: "protected_worktree", reason: "no" }).decision,
    ).toBe("block");
    expect(
      policyResult({ decision: "requireApproval", reasonCode: "approval_required", reason: "ask" })
        .decision,
    ).toBe("requireApproval");
  });

  it("redacts secret-like keys, truncates long text, and is deterministic", () => {
    const value = { z: "ok", token: "secret", nested: { password: "pw", text: "x".repeat(200) } };
    expect(summarizePolicyPayload(value)).toEqual(summarizePolicyPayload(value));
    expect(JSON.stringify(summarizePolicyPayload(value))).not.toContain("secret");
    expect(JSON.stringify(summarizePolicyPayload(value))).toContain("truncated");
  });

  it("allows by default and preserves reasons", () => {
    expect(evaluateActionSinkPolicy(request).decision).toBe("allow");
    const result = evaluateActionSinkPolicy(request, {}, [
      {
        id: "m",
        evaluate: () =>
          policyResult({
            policyId: "m",
            decision: "block",
            reasonCode: "invalid_request",
            reason: "bad",
          }),
      },
    ]);
    expect(result).toMatchObject({ decision: "block", policyId: "m", reason: "bad" });
  });

  it("uses first block/approval and applies shadow semantics", () => {
    const modules = [
      {
        id: "a",
        evaluate: () =>
          policyResult({
            policyId: "a",
            decision: "requireApproval",
            reasonCode: "approval_required",
            reason: "ask",
          }),
      },
      {
        id: "b",
        evaluate: () =>
          policyResult({
            policyId: "b",
            decision: "block",
            reasonCode: "invalid_request",
            reason: "bad",
          }),
      },
    ];
    expect(evaluateActionSinkPolicy(request, {}, modules).decision).toBe("requireApproval");
    expect(evaluateActionSinkPolicy(request, { defaultMode: "shadow" }, modules).decision).toBe(
      "allow",
    );
  });
});
