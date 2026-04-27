import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveEffectiveToolFsRootExpansionAllowed, resolveEffectiveToolFsWorkspaceOnly, } from "../agents/tool-fs-policy.js";
import { resolveStateDir } from "../config/paths.js";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { isPassThroughRemoteMediaSource } from "./media-source-url.js";
let cachedPreferredTmpDir;
const DATA_URL_RE = /^data:/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
function resolveCachedPreferredTmpDir() {
    if (!cachedPreferredTmpDir) {
        cachedPreferredTmpDir = resolvePreferredOpenClawTmpDir();
    }
    return cachedPreferredTmpDir;
}
export function buildMediaLocalRoots(stateDir, configDir, options = {}) {
    const resolvedStateDir = path.resolve(stateDir);
    const resolvedConfigDir = path.resolve(configDir);
    const preferredTmpDir = options.preferredTmpDir ?? resolveCachedPreferredTmpDir();
    return Array.from(new Set([
        preferredTmpDir,
        path.join(resolvedConfigDir, "media"),
        path.join(resolvedStateDir, "media"),
        path.join(resolvedStateDir, "canvas"),
        path.join(resolvedStateDir, "workspace"),
        path.join(resolvedStateDir, "sandboxes"),
    ]));
}
export function getDefaultMediaLocalRoots() {
    return buildMediaLocalRoots(resolveStateDir(), resolveConfigDir());
}
export function getAgentScopedMediaLocalRoots(cfg, agentId) {
    const roots = buildMediaLocalRoots(resolveStateDir(), resolveConfigDir());
    const normalizedAgentId = normalizeOptionalString(agentId);
    if (!normalizedAgentId) {
        return roots;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, normalizedAgentId);
    if (!workspaceDir) {
        return roots;
    }
    const normalizedWorkspaceDir = path.resolve(workspaceDir);
    if (!roots.includes(normalizedWorkspaceDir)) {
        roots.push(normalizedWorkspaceDir);
    }
    return roots;
}
function resolveLocalMediaPath(source) {
    const trimmed = source.trim();
    if (!trimmed || isPassThroughRemoteMediaSource(trimmed) || DATA_URL_RE.test(trimmed)) {
        return undefined;
    }
    if (trimmed.startsWith("file://")) {
        try {
            return safeFileURLToPath(trimmed);
        }
        catch {
            return undefined;
        }
    }
    if (trimmed.startsWith("~")) {
        return resolveUserPath(trimmed);
    }
    if (path.isAbsolute(trimmed) || WINDOWS_DRIVE_RE.test(trimmed)) {
        return path.resolve(trimmed);
    }
    return undefined;
}
export function appendLocalMediaParentRoots(roots, mediaSources) {
    const appended = Array.from(new Set(roots.map((root) => path.resolve(root))));
    for (const source of mediaSources ?? []) {
        const localPath = resolveLocalMediaPath(source);
        if (!localPath) {
            continue;
        }
        const parentDir = path.dirname(localPath);
        if (parentDir === path.parse(parentDir).root) {
            continue;
        }
        const normalizedParent = path.resolve(parentDir);
        if (!appended.includes(normalizedParent)) {
            appended.push(normalizedParent);
        }
    }
    return appended;
}
export function getAgentScopedMediaLocalRootsForSources(params) {
    const roots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
    if (resolveEffectiveToolFsWorkspaceOnly({ cfg: params.cfg, agentId: params.agentId })) {
        return roots;
    }
    if (!resolveEffectiveToolFsRootExpansionAllowed({ cfg: params.cfg, agentId: params.agentId })) {
        return roots;
    }
    return appendLocalMediaParentRoots(roots, params.mediaSources);
}
