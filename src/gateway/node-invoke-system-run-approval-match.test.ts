import { describe, expect, test } from "vitest";
import { approvalMatchesSystemRunRequest } from "./node-invoke-system-run-approval-match.js";
import { buildSystemRunApprovalEnvBinding } from "./system-run-approval-env-binding.js";

describe("approvalMatchesSystemRunRequest", () => {
  test("matches legacy command text when binding fields match", () => {
    const result = approvalMatchesSystemRunRequest({
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
    expect(result).toBe(true);
  });

  test("rejects legacy command mismatch", () => {
    const result = approvalMatchesSystemRunRequest({
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
    expect(result).toBe(false);
  });

  test("enforces exact argv binding when commandArgv is set", () => {
    const result = approvalMatchesSystemRunRequest({
      cmdText: "echo SAFE",
      argv: ["echo", "SAFE"],
      request: {
        host: "node",
        command: "echo SAFE",
        commandArgv: ["echo", "SAFE"],
      },
      binding: {
        cwd: null,
        agentId: null,
        sessionKey: null,
      },
    });
    expect(result).toBe(true);
  });

  test("rejects argv mismatch even when command text matches", () => {
    const result = approvalMatchesSystemRunRequest({
      cmdText: "echo SAFE",
      argv: ["echo", "SAFE"],
      request: {
        host: "node",
        command: "echo SAFE",
        commandArgv: ["echo SAFE"],
      },
      binding: {
        cwd: null,
        agentId: null,
        sessionKey: null,
      },
    });
    expect(result).toBe(false);
  });

  test("rejects env overrides when approval record lacks env hash", () => {
    const result = approvalMatchesSystemRunRequest({
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
    expect(result).toBe(false);
  });

  test("accepts matching env hash with reordered keys", () => {
    const binding = buildSystemRunApprovalEnvBinding({
      SAFE_A: "1",
      SAFE_B: "2",
    });
    const result = approvalMatchesSystemRunRequest({
      cmdText: "git diff",
      argv: ["git", "diff"],
      request: {
        host: "node",
        command: "git diff",
        commandArgv: ["git", "diff"],
        envHash: binding.envHash,
      },
      binding: {
        cwd: null,
        agentId: null,
        sessionKey: null,
        env: { SAFE_B: "2", SAFE_A: "1" },
      },
    });
    expect(result).toBe(true);
  });

  test("rejects non-node host requests", () => {
    const result = approvalMatchesSystemRunRequest({
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
    expect(result).toBe(false);
  });
});
