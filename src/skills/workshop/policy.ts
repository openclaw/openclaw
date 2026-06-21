// Workshop policy helpers validate generated skill drafts against workspace policy.
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginHookBeforeToolCallResult } from "../../plugins/hook-before-tool-call-result.js";
import { resolveSkillWorkshopConfig } from "./config.js";

const SKILL_WORKSHOP_LIFECYCLE_ACTIONS = new Set(["apply", "reject", "quarantine"]);

type SkillWorkshopLifecycleAction = "apply" | "reject" | "quarantine";

// Only lifecycle actions mutate proposals and therefore require approval checks.
function readLifecycleAction(params: unknown): SkillWorkshopLifecycleAction | undefined {
  const action = asNullableRecord(params)?.action;
  if (typeof action !== "string" || !SKILL_WORKSHOP_LIFECYCLE_ACTIONS.has(action)) {
    return undefined;
  }
  return action as SkillWorkshopLifecycleAction;
}

function lifecycleApprovalText(action: SkillWorkshopLifecycleAction): {
  title: string;
  description: string;
  severity: "info" | "warning";
} {
  if (action === "apply") {
    return {
      title: "Apply workspace skill proposal",
      description: "Apply a pending workspace skill proposal into live workspace skills.",
      severity: "warning",
    };
  }
  if (action === "reject") {
    return {
      title: "Reject workspace skill proposal",
      description: "Reject a pending workspace skill proposal.",
      severity: "info",
    };
  }
  return {
    title: "Quarantine workspace skill proposal",
    description: "Quarantine a pending workspace skill proposal.",
    severity: "info",
  };
}

function resolveLifecycleApprovalWorkspaceScope(params: {
  workspaceDir?: string;
  cwd?: string;
}): string | undefined {
  const workspaceDir = normalizeOptionalString(params.workspaceDir ?? params.cwd);
  return workspaceDir ? path.resolve(workspaceDir) : undefined;
}

function buildLifecycleApprovalAllowAlwaysKey(params: {
  action: SkillWorkshopLifecycleAction;
  workspaceDir: string;
}): string {
  return `skill-workshop:lifecycle:${params.action}:${params.workspaceDir}`;
}

/** Returns approval policy for skill workshop lifecycle tool calls. */
export function resolveSkillWorkshopToolApproval(params: {
  toolName: string;
  toolParams: unknown;
  config?: OpenClawConfig;
  workspaceDir?: string;
  cwd?: string;
}): PluginHookBeforeToolCallResult | undefined {
  if (params.toolName !== "skill_workshop") {
    return undefined;
  }
  const action = readLifecycleAction(params.toolParams);
  if (!action) {
    return undefined;
  }
  const config = resolveSkillWorkshopConfig(params.config);
  if (config.approvalPolicy === "auto") {
    return undefined;
  }
  const workspaceScope = resolveLifecycleApprovalWorkspaceScope(params);
  const text = lifecycleApprovalText(action);
  const allowedDecisions = workspaceScope
    ? (["allow-once", "allow-always", "deny"] as const)
    : (["allow-once", "deny"] as const);
  return {
    requireApproval: {
      ...text,
      allowedDecisions: [...allowedDecisions],
      ...(workspaceScope
        ? {
            allowAlwaysKey: buildLifecycleApprovalAllowAlwaysKey({
              action,
              workspaceDir: workspaceScope,
            }),
          }
        : {}),
    },
  };
}
