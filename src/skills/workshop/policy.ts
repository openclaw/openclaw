import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginHookBeforeToolCallResult } from "../../plugins/types.js";
import { asNullableRecord } from "../../shared/record-coerce.js";
import { resolveSkillWorkshopConfig } from "./config.js";

const SKILL_RESEARCH_LIFECYCLE_ACTIONS = new Set(["apply", "reject", "quarantine"]);

type SkillResearchLifecycleAction = "apply" | "reject" | "quarantine";

function readLifecycleAction(params: unknown): SkillResearchLifecycleAction | undefined {
  const action = asNullableRecord(params)?.action;
  if (typeof action !== "string" || !SKILL_RESEARCH_LIFECYCLE_ACTIONS.has(action)) {
    return undefined;
  }
  return action as SkillResearchLifecycleAction;
}

function lifecycleApprovalText(action: SkillResearchLifecycleAction): {
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

export function resolveSkillResearchToolApproval(params: {
  toolName: string;
  toolParams: unknown;
  config?: OpenClawConfig;
}): PluginHookBeforeToolCallResult | undefined {
  if (params.toolName !== "skill_research") {
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
  const text = lifecycleApprovalText(action);
  return {
    requireApproval: {
      ...text,
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}
