import { describe, expect, test } from "vitest";
import { evaluateSystemRunApprovalMatch } from "./node-invoke-system-run-approval-match.js";
import {
  buildSystemRunApprovalBindingV1,
  buildSystemRunApprovalEnvBinding,
} from "./system-run-approval-binding.js";

describe("evaluateSystemRunApprovalMatch", () => {
  test("matches legacy command text when binding fields match", () => {
    const result = evaluateSystemRunApprovalMatch({
      cmdText: "echo SAFE",
      argv: ["echo", "SAFE"],
      request: {
        host: "node",
        command: "echo SAFE",
        cwd: "/tmp",
        agentId: "agent-1",
        sessionKey: "session-1",
      },
      binding: {
        cwd: "/tmp",
        agentId: "agent-1",
        sessionKey: "session-1",
      },
    });
    expect(result).toEqual({ ok: true });
  });

  test("rejects legacy command mismatch", () => {
    const result = evaluateSystemRunApprovalMatch({
      cmdText: "echo PWNED",
      argv: ["echo", "PWNED"],
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
      cmdText: "echo SAFE",
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
      cmdText: "echo SAFE",
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

  test("rejects env overrides when approval record lacks env binding", () => {
    const result = evaluateSystemRunApprovalMatch({
      cmdText: "git diff",
      argv: ["git", "diff"],
      request: {
        host: "node",
        command: "git diff",
        commandArgv: ["git", "diff"],
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
    const envBinding = buildSystemRunApprovalEnvBinding({
      SAFE_A: "1",
      SAFE_B: "2",
    });
    const result = evaluateSystemRunApprovalMatch({
      cmdText: "git diff",
      argv: ["git", "diff"],
      request: {
        host: "node",
        command: "git diff",
        commandArgv: ["git", "diff"],
        envHash: envBinding.envHash,
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
      cmdText: "echo SAFE",
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

  test("prefers v1 binding over legacy command text fields", () => {
    const result = evaluateSystemRunApprovalMatch({
      cmdText: "echo SAFE",
      argv: ["echo", "SAFE"],
      request: {
        host: "node",
        // Intentionally stale legacy fields; v1 should be authoritative.
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

  test("rejects v1 mismatch even when legacy command text matches", () => {
    const result = evaluateSystemRunApprovalMatch({
      cmdText: "echo SAFE",
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
});
