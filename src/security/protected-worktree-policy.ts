import fs from "node:fs";
import path from "node:path";
import type { ActionSinkPolicyConfig } from "./action-sink-policy-config.js";
import type { PolicyModule, PolicyRequest, PolicyResult } from "./action-sink-policy.js";
import { policyResult } from "./action-sink-policy.js";
import { classifyShellCommand } from "./action-sink-shell-policy.js";

export type RealpathFn = (target: string) => string;

export function normalizePolicyPath(
  target: string,
  realpath: RealpathFn = fs.realpathSync.native,
): string {
  const resolved = path.resolve(target);
  try {
    return realpath(resolved);
  } catch {
    return resolved;
  }
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function evaluateProtectedWorktree(params: {
  request: PolicyRequest;
  config: Pick<ActionSinkPolicyConfig, "protectedRoots" | "assignedWorktrees">;
  realpath?: RealpathFn;
}): PolicyResult | undefined {
  const target =
    params.request.targetResource ??
    (typeof params.request.context?.cwd === "string" ? params.request.context.cwd : "");
  const normalizedTarget = target ? normalizePolicyPath(target, params.realpath) : "";
  const protectedRoot = params.config.protectedRoots.find((root) =>
    isPathInside(normalizePolicyPath(root, params.realpath), normalizedTarget),
  );
  const action = params.request.actionType;
  const isMutation = ["file_write", "git_mutation", "shell_exec"].includes(action);
  if (!isMutation) {
    return undefined;
  }

  if (action === "shell_exec") {
    const command =
      (typeof params.request.context?.command === "string"
        ? params.request.context.command
        : undefined) ??
      (typeof params.request.payloadSummary === "string" ? params.request.payloadSummary : "");
    const shell = classifyShellCommand({ command, cwd: target });
    if (!shell.highRisk) {
      return undefined;
    }
  }

  if (protectedRoot) {
    return policyResult({
      policyId: "protectedWorktree",
      decision: "block",
      reasonCode: "protected_worktree",
      reason: `Mutation targets protected root ${protectedRoot}`,
      correlationId: params.request.correlationId,
    });
  }

  const issueId =
    typeof params.request.context?.issueId === "string"
      ? params.request.context.issueId
      : undefined;
  if (params.config.assignedWorktrees.length > 0 && issueId) {
    const assignment = params.config.assignedWorktrees.find(
      (item) => !item.issueId || item.issueId === issueId,
    );
    if (
      assignment &&
      !isPathInside(
        normalizePolicyPath(assignment.worktreeRoot, params.realpath),
        normalizedTarget ||
          (typeof params.request.context?.cwd === "string" ? params.request.context.cwd : ""),
      )
    ) {
      return policyResult({
        policyId: "protectedWorktree",
        decision: "block",
        reasonCode: "unassigned_worktree",
        reason: `Mutation is outside assigned worktree ${assignment.worktreeRoot}`,
        correlationId: params.request.correlationId,
      });
    }
  }
  return undefined;
}

export function createProtectedWorktreePolicyModule(config: ActionSinkPolicyConfig): PolicyModule {
  return {
    id: "protectedWorktree",
    evaluate: (request) => evaluateProtectedWorktree({ request, config }),
  };
}
