import { resolveAgentConfig } from "./agent-scope.js";
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
