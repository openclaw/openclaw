import { resolveAgentConfig } from "./agent-scope.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import { isToolAllowedByPolicies } from "./tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "./tool-policy.js";
export function createToolFsPolicy(params) {
    return {
        workspaceOnly: params.workspaceOnly === true,
    };
}
export function resolveToolFsConfig(params) {
    const cfg = params.cfg;
    const globalFs = cfg?.tools?.fs;
    const agentFs = cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
    return {
        workspaceOnly: agentFs?.workspaceOnly ?? globalFs?.workspaceOnly,
    };
}
export function resolveEffectiveToolFsWorkspaceOnly(params) {
    return resolveToolFsConfig(params).workspaceOnly === true;
}
export function resolveEffectiveToolFsRootExpansionAllowed(params) {
    const cfg = params.cfg;
    if (!cfg) {
        return true;
    }
    const agentTools = params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools : undefined;
    const globalTools = cfg.tools;
    const profile = agentTools?.profile ?? globalTools?.profile;
    const profileAlsoAllow = new Set(agentTools?.alsoAllow ?? globalTools?.alsoAllow ?? []);
    const fsConfig = resolveToolFsConfig(params);
    const hasExplicitFsConfig = agentTools?.fs !== undefined || globalTools?.fs !== undefined;
    if (fsConfig.workspaceOnly === true) {
        return false;
    }
    if (hasExplicitFsConfig) {
        profileAlsoAllow.add("read");
        profileAlsoAllow.add("write");
        profileAlsoAllow.add("edit");
    }
    const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow.size > 0 ? Array.from(profileAlsoAllow) : undefined);
    const globalPolicy = pickSandboxToolPolicy(globalTools);
    const agentPolicy = pickSandboxToolPolicy(agentTools);
    return isToolAllowedByPolicies("read", [profilePolicy, globalPolicy, agentPolicy]);
}
