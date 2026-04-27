import { filterToolsByPolicy } from "./pi-tools.policy.js";
import { isKnownCoreToolId } from "./tool-catalog.js";
import { analyzeAllowlistByToolType, buildPluginToolGroups, expandPolicyWithPluginGroups, normalizeToolName, } from "./tool-policy.js";
const MAX_TOOL_POLICY_WARNING_CACHE = 256;
const seenToolPolicyWarnings = new Set();
const toolPolicyWarningOrder = [];
function rememberToolPolicyWarning(warning) {
    if (seenToolPolicyWarnings.has(warning)) {
        return false;
    }
    if (seenToolPolicyWarnings.size >= MAX_TOOL_POLICY_WARNING_CACHE) {
        const oldest = toolPolicyWarningOrder.shift();
        if (oldest) {
            seenToolPolicyWarnings.delete(oldest);
        }
    }
    seenToolPolicyWarnings.add(warning);
    toolPolicyWarningOrder.push(warning);
    return true;
}
export function buildDefaultToolPolicyPipelineSteps(params) {
    const agentId = params.agentId?.trim();
    const profile = params.profile?.trim();
    const providerProfile = params.providerProfile?.trim();
    return [
        {
            policy: params.profilePolicy,
            label: profile ? `tools.profile (${profile})` : "tools.profile",
            stripPluginOnlyAllowlist: true,
            suppressUnavailableCoreToolWarningAllowlist: params.profileUnavailableCoreWarningAllowlist,
        },
        {
            policy: params.providerProfilePolicy,
            label: providerProfile
                ? `tools.byProvider.profile (${providerProfile})`
                : "tools.byProvider.profile",
            stripPluginOnlyAllowlist: true,
            suppressUnavailableCoreToolWarningAllowlist: params.providerProfileUnavailableCoreWarningAllowlist,
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
            const resolved = analyzeAllowlistByToolType(policy, pluginGroups, coreToolNames);
            if (resolved.unknownAllowlist.length > 0) {
                const unavailableCoreWarningAllowlist = new Set((step.suppressUnavailableCoreToolWarningAllowlist ?? []).map((entry) => normalizeToolName(entry)));
                const gatedCoreEntries = resolved.unknownAllowlist.filter((entry) => isKnownCoreToolId(entry));
                const warnableGatedCoreEntries = step.suppressUnavailableCoreToolWarning
                    ? []
                    : gatedCoreEntries.filter((entry) => !unavailableCoreWarningAllowlist.has(entry));
                const otherEntries = resolved.unknownAllowlist.filter((entry) => !isKnownCoreToolId(entry) && !unavailableCoreWarningAllowlist.has(entry));
                const warningEntries = [...warnableGatedCoreEntries, ...otherEntries];
                if (shouldWarnAboutUnknownAllowlist({
                    hasGatedCoreEntries: warnableGatedCoreEntries.length > 0,
                    hasOtherEntries: otherEntries.length > 0,
                })) {
                    const entries = warningEntries.join(", ");
                    const suffix = describeUnknownAllowlistSuffix({
                        pluginOnlyAllowlist: resolved.pluginOnlyAllowlist,
                        hasGatedCoreEntries: warnableGatedCoreEntries.length > 0,
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
function shouldWarnAboutUnknownAllowlist(params) {
    return params.hasGatedCoreEntries || params.hasOtherEntries;
}
function describeUnknownAllowlistSuffix(params) {
    const preface = params.pluginOnlyAllowlist
        ? "Allowlist contains only plugin entries; core tools will not be available."
        : "";
    const detail = params.hasGatedCoreEntries && params.hasOtherEntries
        ? "Some entries are shipped core tools but unavailable in the current runtime/provider/model/config; other entries won't match any tool unless the plugin is enabled."
        : params.hasGatedCoreEntries
            ? "These entries are shipped core tools but unavailable in the current runtime/provider/model/config."
            : "These entries won't match any tool unless the plugin is enabled.";
    return preface ? `${preface} ${detail}` : detail;
}
export function resetToolPolicyWarningCacheForTest() {
    seenToolPolicyWarnings.clear();
    toolPolicyWarningOrder.length = 0;
}
