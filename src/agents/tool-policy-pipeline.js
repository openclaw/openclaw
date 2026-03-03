import { filterToolsByPolicy } from "./pi-tools.policy.js";
import { buildPluginToolGroups, expandPolicyWithPluginGroups, normalizeToolName, stripPluginOnlyAllowlist, } from "./tool-policy.js";
export function buildDefaultToolPolicyPipelineSteps(params) {
    const agentId = params.agentId?.trim();
    const profile = params.profile?.trim();
    const providerProfile = params.providerProfile?.trim();
    return [
        {
            policy: params.profilePolicy,
            label: profile ? `tools.profile (${profile})` : "tools.profile",
            stripPluginOnlyAllowlist: true,
        },
        {
            policy: params.providerProfilePolicy,
            label: providerProfile
                ? `tools.byProvider.profile (${providerProfile})`
                : "tools.byProvider.profile",
            stripPluginOnlyAllowlist: true,
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
export function applyToolPolicyPipeline(params) {
    const coreToolNames = new Set(params.tools
        .filter((tool) => !params.toolMeta(tool))
        .map((tool) => normalizeToolName(tool.name))
        .filter(Boolean));
    const pluginGroups = buildPluginToolGroups({
        tools: params.tools,
        toolMeta: params.toolMeta,
    });
    let filtered = params.tools;
    for (const step of params.steps) {
        if (!step.policy) {
            continue;
        }
        let policy = step.policy;
        if (step.stripPluginOnlyAllowlist) {
            const resolved = stripPluginOnlyAllowlist(policy, pluginGroups, coreToolNames);
            if (resolved.unknownAllowlist.length > 0) {
                const entries = resolved.unknownAllowlist.join(", ");
                const suffix = resolved.strippedAllowlist
                    ? "Ignoring allowlist so core tools remain available. Use tools.alsoAllow for additive plugin tool enablement."
                    : "These entries won't match any tool unless the plugin is enabled.";
                params.warn(`tools: ${step.label} allowlist contains unknown entries (${entries}). ${suffix}`);
            }
            policy = resolved.policy;
        }
        const expanded = expandPolicyWithPluginGroups(policy, pluginGroups);
        filtered = expanded ? filterToolsByPolicy(filtered, expanded) : filtered;
    }
    return filtered;
}
