import type { AnyAgentTool } from "./pi-tools.types.js";
import { filterToolsByPolicy } from "./pi-tools.policy.js";
import {
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  stripPluginOnlyAllowlist,
  type ToolPolicyLike,
} from "./tool-policy.js";

export type ToolPolicyPipelineStep = {
  policy: ToolPolicyLike | undefined;
  label: string;
  stripPluginOnlyAllowlist?: boolean;
};

export function applyToolPolicyPipeline(params: {
  tools: AnyAgentTool[];
  toolMeta: (tool: AnyAgentTool) => { pluginId: string } | undefined;
  warn: (message: string) => void;
  steps: ToolPolicyPipelineStep[];
}): AnyAgentTool[] {
  const coreToolNames = new Set(
    params.tools
      .filter((tool) => !params.toolMeta(tool))
      .map((tool) => normalizeToolName(tool.name))
      .filter(Boolean),
  );

  const pluginGroups = buildPluginToolGroups({
    tools: params.tools,
    toolMeta: params.toolMeta,
  });

  let filtered = params.tools;
  for (const step of params.steps) {
    if (!step.policy) {
      continue;
    }

    let policy: ToolPolicyLike | undefined = step.policy;
    if (step.stripPluginOnlyAllowlist) {
      const resolved = stripPluginOnlyAllowlist(policy, pluginGroups, coreToolNames);
      if (resolved.unknownAllowlist.length > 0) {
        const entries = resolved.unknownAllowlist.join(", ");
        const suffix = resolved.strippedAllowlist
          ? "Ignoring allowlist so core tools remain available. Use tools.alsoAllow for additive plugin tool enablement."
          : "These entries won't match any tool unless the plugin is enabled.";
        params.warn(
          `tools: ${step.label} allowlist contains unknown entries (${entries}). ${suffix}`,
        );
      }
      policy = resolved.policy;
    }

    const expanded = expandPolicyWithPluginGroups(policy, pluginGroups);
    filtered = expanded ? filterToolsByPolicy(filtered, expanded) : filtered;
  }
  return filtered;
}
