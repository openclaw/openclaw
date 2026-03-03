import { describe, expect, it } from "vitest";
import { isRoleOrderingConflictError } from "./agent-runner-execution.js";

describe("isRoleOrderingConflictError", () => {
  it("matches legacy role-ordering conflict errors", () => {
    expect(isRoleOrderingConflictError("400 Incorrect role information")).toBe(true);
    expect(
      isRoleOrderingConflictError('messages: roles must alternate between "user" and "assistant"'),
    ).toBe(true);
  });

  it("matches Mistral user-after-tool role ordering errors", () => {
    expect(
      isRoleOrderingConflictError("ValueError: Unexpected role 'user' after role 'tool'"),
    ).toBe(true);
    expect(
      isRoleOrderingConflictError('ValueError: Unexpected role "user" after role "tool"'),
    ).toBe(true);
  });

  it("does not match mixed quote delimiters in role ordering errors", () => {
    expect(
      isRoleOrderingConflictError("ValueError: Unexpected role 'user\" after role \"tool'"),
    ).toBe(false);
  });

  it("does not match unrelated errors", () => {
    expect(isRoleOrderingConflictError("network timeout")).toBe(false);
  });
});
