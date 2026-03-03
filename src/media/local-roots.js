import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
let cachedPreferredTmpDir;
function resolveCachedPreferredTmpDir() {
    if (!cachedPreferredTmpDir) {
        cachedPreferredTmpDir = resolvePreferredOpenClawTmpDir();
    }
    return cachedPreferredTmpDir;
}
function buildMediaLocalRoots(stateDir, options = {}) {
    const resolvedStateDir = path.resolve(stateDir);
    const preferredTmpDir = options.preferredTmpDir ?? resolveCachedPreferredTmpDir();
    return [
        preferredTmpDir,
        path.join(resolvedStateDir, "media"),
        path.join(resolvedStateDir, "agents"),
        path.join(resolvedStateDir, "workspace"),
        path.join(resolvedStateDir, "sandboxes"),
    ];
}
export function getDefaultMediaLocalRoots() {
    return buildMediaLocalRoots(resolveStateDir());
}
export function getAgentScopedMediaLocalRoots(cfg, agentId) {
    const roots = buildMediaLocalRoots(resolveStateDir());
    if (!agentId?.trim()) {
        return roots;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    if (!workspaceDir) {
        return roots;
    }
    const normalizedWorkspaceDir = path.resolve(workspaceDir);
    if (!roots.includes(normalizedWorkspaceDir)) {
        roots.push(normalizedWorkspaceDir);
    }
    return roots;
}
