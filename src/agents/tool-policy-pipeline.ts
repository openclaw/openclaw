import { filterToolsByPolicy } from "./pi-tools.policy.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { isKnownCoreToolId } from "./tool-catalog.js";
import {
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  stripPluginOnlyAllowlist,
  type ToolPolicyLike,
} from "./tool-policy.js";

const MAX_TOOL_POLICY_WARNING_CACHE = 256;
const seenToolPolicyWarnings = new Set<string>();

function rememberToolPolicyWarning(warning: string): boolean {
  if (seenToolPolicyWarnings.has(warning)) {
    return false;
  }
  if (seenToolPolicyWarnings.size >= MAX_TOOL_POLICY_WARNING_CACHE) {
    const oldest = seenToolPolicyWarnings.values().next().value;
    if (oldest) {
      seenToolPolicyWarnings.delete(oldest);
    }
  }
  seenToolPolicyWarnings.add(warning);
  return true;
}

export type ToolPolicyPipelineStep = {
  policy: ToolPolicyLike | undefined;
  label: string;
  stripPluginOnlyAllowlist?: boolean;
  suppressUnavailableCoreToolWarning?: boolean;
};

export function buildDefaultToolPolicyPipelineSteps(params: {
  profilePolicy?: ToolPolicyLike;
  profile?: string;
  profileAlsoAllow?: string[];
  providerProfilePolicy?: ToolPolicyLike;
  providerProfile?: string;
  providerProfileAlsoAllow?: string[];
  globalPolicy?: ToolPolicyLike;
  globalProviderPolicy?: ToolPolicyLike;
  agentPolicy?: ToolPolicyLike;
  agentProviderPolicy?: ToolPolicyLike;
  groupPolicy?: ToolPolicyLike;
  agentId?: string;
}): ToolPolicyPipelineStep[] {
  const agentId = params.agentId?.trim();
  const profile = params.profile?.trim();
  const providerProfile = params.providerProfile?.trim();
  return [
    {
      policy: params.profilePolicy,
      label: profile ? `tools.profile (${profile})` : "tools.profile",
      stripPluginOnlyAllowlist: true,
      suppressUnavailableCoreToolWarning:
        !Array.isArray(params.profileAlsoAllow) || params.profileAlsoAllow.length === 0,
    },
    {
      policy: params.providerProfilePolicy,
      label: providerProfile
        ? `tools.byProvider.profile (${providerProfile})`
        : "tools.byProvider.profile",
      stripPluginOnlyAllowlist: true,
      suppressUnavailableCoreToolWarning:
        !Array.isArray(params.providerProfileAlsoAllow) ||
        params.providerProfileAlsoAllow.length === 0,
    },
    { policy: params.globalPolicy, label: "tools.allow", stripPluginOnlyAllowlist: true },
    {
      policy: params.globalProviderPolicy,
      label: "tools.byProvider.allow",
      stripPluginOnlyAllowlist: true,
    },
    {
      policy: params.agentPolicy,
      label: agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
      stripPluginOnlyAllowlist: true,
    },
    {
      policy: params.agentProviderPolicy,
      label: agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
      stripPluginOnlyAllowlist: true,
    },
    { policy: params.groupPolicy, label: "group tools.allow", stripPluginOnlyAllowlist: true },
  ];
}

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
        const gatedCoreEntries = resolved.unknownAllowlist.filter((entry) =>
          isKnownCoreToolId(entry),
        );
        const otherEntries = resolved.unknownAllowlist.filter((entry) => !isKnownCoreToolId(entry));
        if (
          !shouldSuppressUnavailableCoreToolWarning({
            suppressUnavailableCoreToolWarning: step.suppressUnavailableCoreToolWarning === true,
            hasGatedCoreEntries: gatedCoreEntries.length > 0,
            hasOtherEntries: otherEntries.length > 0,
          })
        ) {
          const suffix = describeUnknownAllowlistSuffix({
            strippedAllowlist: resolved.strippedAllowlist,
            hasGatedCoreEntries: gatedCoreEntries.length > 0,
            hasOtherEntries: otherEntries.length > 0,
          });
          const warning = `tools: ${step.label} allowlist contains unknown entries (${entries}). ${suffix}`;
          if (rememberToolPolicyWarning(warning)) {
            params.warn(warning);
          }
        }
      }
      policy = resolved.policy;
    }

    const expanded = expandPolicyWithPluginGroups(policy, pluginGroups);
    filtered = expanded ? filterToolsByPolicy(filtered, expanded) : filtered;
  }
  return filtered;
}

function shouldSuppressUnavailableCoreToolWarning(params: {
  suppressUnavailableCoreToolWarning: boolean;
  hasGatedCoreEntries: boolean;
  hasOtherEntries: boolean;
}): boolean {
  if (
    !params.suppressUnavailableCoreToolWarning ||
    !params.hasGatedCoreEntries ||
    params.hasOtherEntries
  ) {
    return false;
  }
  return true;
}

function describeUnknownAllowlistSuffix(params: {
  strippedAllowlist: boolean;
  hasGatedCoreEntries: boolean;
  hasOtherEntries: boolean;
}): string {
  const preface = params.strippedAllowlist
    ? "Ignoring allowlist so core tools remain available."
    : "";
  const detail =
    params.hasGatedCoreEntries && params.hasOtherEntries
      ? "Some entries are shipped core tools but unavailable in the current runtime/provider/model/config; other entries won't match any tool unless the plugin is enabled."
      : params.hasGatedCoreEntries
        ? "These entries are shipped core tools but unavailable in the current runtime/provider/model/config."
        : "These entries won't match any tool unless the plugin is enabled.";
  return preface ? `${preface} ${detail}` : detail;
}

export function resetToolPolicyWarningCacheForTest(): void {
  seenToolPolicyWarnings.clear();
}
