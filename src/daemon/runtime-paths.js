import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isSupportedNodeVersion } from "../infra/runtime-guard.js";
import { resolveStableNodePath } from "../infra/stable-node-path.js";
import { getWindowsProgramFilesRoots } from "../infra/windows-install-roots.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
const VERSION_MANAGER_MARKERS = [
    "/.nvm/",
    "/.fnm/",
    "/.volta/",
    "/.asdf/",
    "/.n/",
    "/.nodenv/",
    "/.nodebrew/",
    "/nvs/",
];
function getPathModule(platform) {
    return platform === "win32" ? path.win32 : path.posix;
}
function isNodeExecPath(execPath, platform) {
    const pathModule = getPathModule(platform);
    const base = normalizeLowercaseStringOrEmpty(pathModule.basename(execPath));
    return base === "node" || base === "node.exe";
}
function normalizeForCompare(input, platform) {
    const pathModule = getPathModule(platform);
    const normalized = pathModule.normalize(input).replaceAll("\\", "/");
    if (platform === "win32") {
        return normalizeLowercaseStringOrEmpty(normalized);
    }
    return normalized;
}
function buildSystemNodeCandidates(env, platform) {
    if (platform === "darwin") {
        return ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
    }
    if (platform === "linux") {
        return ["/usr/local/bin/node", "/usr/bin/node"];
    }
    if (platform === "win32") {
        const pathModule = getPathModule(platform);
        return getWindowsProgramFilesRoots(env).map((root) => pathModule.join(root, "nodejs", "node.exe"));
    }
    return [];
}
const execFileAsync = promisify(execFile);
async function resolveNodeVersion(nodePath, execFileImpl) {
    try {
        const { stdout } = await execFileImpl(nodePath, ["-p", "process.versions.node"], {
            encoding: "utf8",
        });
        const value = stdout.trim();
        return value ? value : null;
    }
    catch {
        return null;
    }
}
export function isVersionManagedNodePath(nodePath, platform = process.platform) {
    const normalized = normalizeForCompare(nodePath, platform);
    return VERSION_MANAGER_MARKERS.some((marker) => normalized.includes(marker));
}
export function isSystemNodePath(nodePath, env = process.env, platform = process.platform) {
    const normalized = normalizeForCompare(nodePath, platform);
    return buildSystemNodeCandidates(env, platform).some((candidate) => {
        const normalizedCandidate = normalizeForCompare(candidate, platform);
        return normalized === normalizedCandidate;
    });
}
export async function resolveSystemNodePath(env = process.env, platform = process.platform) {
    const candidates = buildSystemNodeCandidates(env, platform);
    for (const candidate of candidates) {
        try {
            await fs.access(candidate);
            return candidate;
        }
        catch {
            // keep going
        }
    }
    return null;
}
export async function resolveSystemNodeInfo(params) {
    const env = params.env ?? process.env;
    const platform = params.platform ?? process.platform;
    const systemNode = await resolveSystemNodePath(env, platform);
    if (!systemNode) {
        return null;
    }
    const version = await resolveNodeVersion(systemNode, params.execFile ?? execFileAsync);
    return {
        path: systemNode,
        version,
        supported: isSupportedNodeVersion(version),
    };
}
export function renderSystemNodeWarning(systemNode, selectedNodePath) {
    if (!systemNode || systemNode.supported) {
        return null;
    }
    const versionLabel = systemNode.version ?? "unknown";
    const selectedLabel = selectedNodePath ? ` Using ${selectedNodePath} for the daemon.` : "";
    return `System Node ${versionLabel} at ${systemNode.path} is below the required Node 22.14+.${selectedLabel} Install Node 24 (recommended) or Node 22 LTS from nodejs.org or Homebrew.`;
}
export { resolveStableNodePath };
export async function resolvePreferredNodePath(params) {
    if (params.runtime !== "node") {
        return undefined;
    }
    // Prefer the node that is currently running `openclaw gateway install`.
    // This respects the user's active version manager (fnm/nvm/volta/etc.).
    const platform = params.platform ?? process.platform;
    const currentExecPath = params.execPath ?? process.execPath;
    if (currentExecPath && isNodeExecPath(currentExecPath, platform)) {
        const execFileImpl = params.execFile ?? execFileAsync;
        const version = await resolveNodeVersion(currentExecPath, execFileImpl);
        if (isSupportedNodeVersion(version)) {
            return resolveStableNodePath(currentExecPath);
        }
    }
    // Fall back to system node.
    const systemNode = await resolveSystemNodeInfo(params);
    if (!systemNode?.supported) {
        return undefined;
    }
    return systemNode.path;
}
