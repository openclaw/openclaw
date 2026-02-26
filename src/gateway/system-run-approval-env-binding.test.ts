import { describe, expect, test } from "vitest";
import {
  buildSystemRunApprovalEnvBinding,
  matchSystemRunApprovalEnvBinding,
} from "./system-run-approval-env-binding.js";

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

describe("matchSystemRunApprovalEnvBinding", () => {
  test("accepts missing env hash when request has no env overrides", () => {
    const result = matchSystemRunApprovalEnvBinding({
      request: {},
      env: undefined,
    });
    expect(result).toEqual({ ok: true });
  });

  test("rejects non-empty env overrides when approval has no env hash", () => {
    const result = matchSystemRunApprovalEnvBinding({
      request: {},
      env: { GIT_EXTERNAL_DIFF: "/tmp/pwn.sh" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("APPROVAL_ENV_BINDING_MISSING");
  });

  test("rejects env hash mismatch", () => {
    const approved = buildSystemRunApprovalEnvBinding({ SAFE: "1" });
    const result = matchSystemRunApprovalEnvBinding({
      request: { envHash: approved.envHash },
      env: { SAFE: "2" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("APPROVAL_ENV_MISMATCH");
  });

  test("accepts matching env hash with key order differences", () => {
    const approved = buildSystemRunApprovalEnvBinding({
      SAFE_A: "1",
      SAFE_B: "2",
    });
    const result = matchSystemRunApprovalEnvBinding({
      request: { envHash: approved.envHash },
      env: {
        SAFE_B: "2",
        SAFE_A: "1",
      },
    });
    expect(result).toEqual({ ok: true });
  });
});
