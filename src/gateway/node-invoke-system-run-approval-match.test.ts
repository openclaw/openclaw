import { describe, expect, test } from "vitest";
import { buildSystemRunApprovalBindingV1 } from "../infra/system-run-approval-binding.js";
import { evaluateSystemRunApprovalMatch } from "./node-invoke-system-run-approval-match.js";

describe("evaluateSystemRunApprovalMatch", () => {
  test("rejects approvals that do not carry v1 binding", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["echo", "SAFE"],
      request: {
        host: "node",
        command: "echo SAFE",
      },
      binding: {
        cwd: null,
        agentId: null,
        sessionKey: null,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("APPROVAL_REQUEST_MISMATCH");
  });

  test("enforces exact argv binding in v1 object", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["echo", "SAFE"],
      request: {
        host: "node",
        command: "echo SAFE",
        systemRunBindingV1: buildSystemRunApprovalBindingV1({
          argv: ["echo", "SAFE"],
          cwd: null,
          agentId: null,
          sessionKey: null,
        }).binding,
      },
      binding: {
        cwd: null,
        agentId: null,
        sessionKey: null,
      },
    });
    expect(result).toEqual({ ok: true });
  });

  test("rejects argv mismatch in v1 object", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["echo", "SAFE"],
      request: {
        host: "node",
        command: "echo SAFE",
        systemRunBindingV1: buildSystemRunApprovalBindingV1({
          argv: ["echo SAFE"],
          cwd: null,
          agentId: null,
          sessionKey: null,
        }).binding,
      },
      binding: {
        cwd: null,
        agentId: null,
        sessionKey: null,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("APPROVAL_REQUEST_MISMATCH");
  });

  test("rejects env overrides when v1 binding has no env hash", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["git", "diff"],
      request: {
        host: "node",
        command: "git diff",
        systemRunBindingV1: buildSystemRunApprovalBindingV1({
          argv: ["git", "diff"],
          cwd: null,
          agentId: null,
          sessionKey: null,
        }).binding,
      },
      binding: {
        cwd: null,
        agentId: null,
        sessionKey: null,
        env: { GIT_EXTERNAL_DIFF: "/tmp/pwn.sh" },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("APPROVAL_ENV_BINDING_MISSING");
  });

  test("accepts matching env hash with reordered keys", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["git", "diff"],
      request: {
        host: "node",
        command: "git diff",
        systemRunBindingV1: buildSystemRunApprovalBindingV1({
          argv: ["git", "diff"],
          cwd: null,
          agentId: null,
          sessionKey: null,
          env: { SAFE_A: "1", SAFE_B: "2" },
        }).binding,
      },
      binding: {
        cwd: null,
        agentId: null,
        sessionKey: null,
        env: { SAFE_B: "2", SAFE_A: "1" },
      },
    });
    expect(result).toEqual({ ok: true });
  });

  test("rejects non-node host requests", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["echo", "SAFE"],
      request: {
        host: "gateway",
        command: "echo SAFE",
      },
      binding: {
        cwd: null,
        agentId: null,
        sessionKey: null,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("APPROVAL_REQUEST_MISMATCH");
  });

  test("uses v1 binding even when legacy command text diverges", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["echo", "SAFE"],
      request: {
        host: "node",
        command: "echo STALE",
        commandArgv: ["echo STALE"],
        systemRunBindingV1: buildSystemRunApprovalBindingV1({
          argv: ["echo", "SAFE"],
          cwd: null,
          agentId: null,
          sessionKey: null,
        }).binding,
      },
      binding: {
        cwd: null,
        agentId: null,
        sessionKey: null,
      },
    });
    expect(result).toEqual({ ok: true });
  });
});
