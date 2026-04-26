import { describe, expect, it } from "vitest";
import { parseActionSinkPolicyConfig } from "./action-sink-policy-config.js";
import {
  evaluateProtectedWorktree,
  isPathInside,
  normalizePolicyPath,
} from "./protected-worktree-policy.js";

const config = parseActionSinkPolicyConfig({
  protectedRoots: ["/protected"],
  assignedWorktrees: [{ issueId: "MCH-61", worktreeRoot: "/workers/mch-61" }],
});

describe("protected worktree policy", () => {
  it("normalizes paths with missing path fallback and symlink realpath injection", () => {
    expect(normalizePolicyPath("/missing/../target", () => "/real/target")).toBe("/real/target");
    expect(normalizePolicyPath("/missing/../target")).toContain("/target");
    expect(isPathInside("/a", "/a/b")).toBe(true);
  });

  it("blocks protected root file writes", () => {
    expect(
      evaluateProtectedWorktree({
        request: {
          policyVersion: "v1",
          actionType: "file_write",
          targetResource: "/protected/file",
        },
        config,
      })?.decision,
    ).toBe("block");
  });

  it("blocks cwd/repo-root confusion outside assigned worktree", () => {
    expect(
      evaluateProtectedWorktree({
        request: {
          policyVersion: "v1",
          actionType: "file_write",
          targetResource: "/tmp/file",
          context: { issueId: "MCH-61" },
        },
        config,
      })?.reasonCode,
    ).toBe("unassigned_worktree");
  });

  it("applies shell risk to protected worktrees", () => {
    expect(
      evaluateProtectedWorktree({
        request: {
          policyVersion: "v1",
          actionType: "shell_exec",
          targetResource: "/protected",
          context: { command: "echo hi > x" },
        },
        config,
      })?.decision,
    ).toBe("block");
    expect(
      evaluateProtectedWorktree({
        request: {
          policyVersion: "v1",
          actionType: "shell_exec",
          targetResource: "/protected",
          context: { command: "git status" },
        },
        config,
      }),
    ).toBeUndefined();
  });
});
