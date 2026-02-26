import { describe, expect, test } from "vitest";
import {
  buildSystemRunApprovalBindingV1,
  buildSystemRunApprovalEnvBinding,
  matchSystemRunApprovalBindingV1,
  matchSystemRunApprovalEnvHash,
  toSystemRunApprovalMismatchError,
} from "../infra/system-run-approval-binding.js";

describe("buildSystemRunApprovalEnvBinding", () => {
  test("normalizes keys and produces stable hash regardless of input order", () => {
    const a = buildSystemRunApprovalEnvBinding({
      Z_VAR: "z",
      A_VAR: "a",
      " BAD KEY": "ignored",
    });
    const b = buildSystemRunApprovalEnvBinding({
      A_VAR: "a",
      Z_VAR: "z",
    });
    expect(a.envKeys).toEqual(["A_VAR", "Z_VAR"]);
    expect(a.envHash).toBe(b.envHash);
  });
});

describe("matchSystemRunApprovalEnvHash", () => {
  test("accepts empty env hash on both sides", () => {
    expect(
      matchSystemRunApprovalEnvHash({
        expectedEnvHash: null,
        actualEnvHash: null,
        actualEnvKeys: [],
      }),
    ).toEqual({ ok: true });
  });

  test("rejects non-empty actual env hash when expected is empty", () => {
    const result = matchSystemRunApprovalEnvHash({
      expectedEnvHash: null,
      actualEnvHash: "hash",
      actualEnvKeys: ["GIT_EXTERNAL_DIFF"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("APPROVAL_ENV_BINDING_MISSING");
  });
});

describe("matchSystemRunApprovalBindingV1", () => {
  test("accepts matching binding with reordered env keys", () => {
    const expected = buildSystemRunApprovalBindingV1({
      argv: ["git", "diff"],
      cwd: null,
      agentId: null,
      sessionKey: null,
      env: { SAFE_A: "1", SAFE_B: "2" },
    });
    const actual = buildSystemRunApprovalBindingV1({
      argv: ["git", "diff"],
      cwd: null,
      agentId: null,
      sessionKey: null,
      env: { SAFE_B: "2", SAFE_A: "1" },
    });
    expect(
      matchSystemRunApprovalBindingV1({
        expected: expected.binding,
        actual: actual.binding,
        actualEnvKeys: actual.envKeys,
      }),
    ).toEqual({ ok: true });
  });

  test("rejects env mismatch", () => {
    const expected = buildSystemRunApprovalBindingV1({
      argv: ["git", "diff"],
      cwd: null,
      agentId: null,
      sessionKey: null,
      env: { SAFE: "1" },
    });
    const actual = buildSystemRunApprovalBindingV1({
      argv: ["git", "diff"],
      cwd: null,
      agentId: null,
      sessionKey: null,
      env: { SAFE: "2" },
    });
    const result = matchSystemRunApprovalBindingV1({
      expected: expected.binding,
      actual: actual.binding,
      actualEnvKeys: actual.envKeys,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("APPROVAL_ENV_MISMATCH");
  });
});

describe("toSystemRunApprovalMismatchError", () => {
  test("includes runId/code and preserves mismatch details", () => {
    const result = toSystemRunApprovalMismatchError({
      runId: "approval-123",
      match: {
        ok: false,
        code: "APPROVAL_ENV_MISMATCH",
        message: "approval id env binding mismatch",
        details: {
          envKeys: ["SAFE_A"],
          expectedEnvHash: "expected-hash",
          actualEnvHash: "actual-hash",
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      message: "approval id env binding mismatch",
      details: {
        code: "APPROVAL_ENV_MISMATCH",
        runId: "approval-123",
        envKeys: ["SAFE_A"],
        expectedEnvHash: "expected-hash",
        actualEnvHash: "actual-hash",
      },
    });
  });
});
