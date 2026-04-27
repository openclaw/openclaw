import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
export function listAgentWorkspaceDirs(cfg) {
    const dirs = new Set();
    const list = cfg.agents?.list;
    if (Array.isArray(list)) {
        for (const entry of list) {
            if (entry && typeof entry === "object" && typeof entry.id === "string") {
                dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
            }
        }
    }
    dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
    return [...dirs];
}
