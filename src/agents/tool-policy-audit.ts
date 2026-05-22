import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SandboxConfig } from "./sandbox/types.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { normalizeToolName, type ToolPolicyLike } from "./tool-policy.js";

const MAX_AUDIT_TOOL_NAMES = 50;
const toolPolicyAuditLogger = createSubsystemLogger("agents/tool-policy");

type ToolPolicyRuleKind = "allow" | "deny" | "allow+deny" | "unknown";

function toolPolicyRuleKind(policy: ToolPolicyLike): ToolPolicyRuleKind {
  const hasAllow = Array.isArray(policy.allow) && policy.allow.length > 0;
  const hasDeny = Array.isArray(policy.deny) && policy.deny.length > 0;
  if (hasAllow && hasDeny) {
    return "allow+deny";
  }
  if (hasDeny) {
    return "deny";
  }
  if (hasAllow) {
    return "allow";
  }
  return "unknown";
}

function normalizedToolNames(tools: readonly { name: string }[]): string[] {
  return tools.map((tool) => normalizeToolName(tool.name)).filter((name) => name.length > 0);
}

function removedToolNamesByRule(params: {
  policy: ToolPolicyLike;
  before: readonly { name: string }[];
  after: readonly { name: string }[];
}): Map<ToolPolicyRuleKind, string[]> {
  const remainingCounts = new Map<string, number>();
  for (const name of normalizedToolNames(params.after)) {
    remainingCounts.set(name, (remainingCounts.get(name) ?? 0) + 1);
  }

  const removed = new Map<ToolPolicyRuleKind, Set<string>>();
  for (const name of normalizedToolNames(params.before)) {
    const remaining = remainingCounts.get(name) ?? 0;
    if (remaining > 0) {
      remainingCounts.set(name, remaining - 1);
      continue;
    }
    const ruleKind = removedToolRuleKind(name, params.policy);
    const names = removed.get(ruleKind) ?? new Set<string>();
    names.add(name);
    removed.set(ruleKind, names);
  }
  return new Map([...removed].map(([ruleKind, names]) => [ruleKind, [...names].toSorted()]));
}

function removedToolRuleKind(toolName: string, policy: ToolPolicyLike): ToolPolicyRuleKind {
  if (
    Array.isArray(policy.deny) &&
    policy.deny.length > 0 &&
    !isToolAllowedByPolicyName(toolName, { deny: policy.deny })
  ) {
    return "deny";
  }
  if (Array.isArray(policy.allow) && policy.allow.length > 0) {
    return "allow";
  }
  return toolPolicyRuleKind(policy);
}

function labelForRuleKind(stepLabel: string, ruleKind: ToolPolicyRuleKind): string {
  if (ruleKind !== "deny") {
    return stepLabel;
  }
  if (stepLabel.includes(".allow")) {
    return stepLabel.replaceAll(".allow", ".deny");
  }
  if (/\ballow\b/u.test(stepLabel)) {
    return stepLabel.replace(/\ballow\b/u, "deny");
  }
  return `${stepLabel}.deny`;
}

function boundedToolNames(names: readonly string[]): {
  toolNames: string[];
  truncated: boolean;
} {
  if (names.length <= MAX_AUDIT_TOOL_NAMES) {
    return { toolNames: [...names], truncated: false };
  }
  return {
    toolNames: names.slice(0, MAX_AUDIT_TOOL_NAMES),
    truncated: true,
  };
}

export function auditToolPolicyFilter(params: {
  stepLabel: string;
  policy: ToolPolicyLike;
  before: readonly { name: string }[];
  after: readonly { name: string }[];
}): void {
  const removedByRule = removedToolNamesByRule({
    policy: params.policy,
    before: params.before,
    after: params.after,
  });
  for (const [ruleKind, removed] of removedByRule) {
    if (removed.length === 0) {
      continue;
    }
    const rule = labelForRuleKind(params.stepLabel, ruleKind);
    const { toolNames, truncated } = boundedToolNames(removed);
    toolPolicyAuditLogger.info(
      `tool policy removed ${removed.length} tool(s) via ${rule}: ${toolNames.join(", ")}`,
      {
        rule,
        ruleKind,
        removedToolCount: removed.length,
        removedTools: toolNames,
        removedToolsTruncated: truncated,
      },
    );
  }
}

export function auditSandboxToolPolicyBlock(params: {
  toolName: string;
  ruleType: "allow" | "deny";
  ruleSource: "agent" | "global" | "default";
  configKey: string;
  mode: SandboxConfig["mode"];
}): void {
  const toolName = normalizeToolName(params.toolName);
  if (!toolName) {
    return;
  }
  toolPolicyAuditLogger.info(
    `sandbox tool policy blocked ${toolName} via ${params.configKey}`,
    {
      tool: toolName,
      ruleKind: params.ruleType,
      ruleSource: params.ruleSource,
      configKey: params.configKey,
      sandboxMode: params.mode,
    },
  );
}
