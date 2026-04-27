import fs from "node:fs";
import path from "node:path";
import { applyMergePatch } from "../config/merge-patch.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
import { inspectBundleServerRuntimeSupport, loadEnabledBundleConfig, readBundleJsonObject, resolveBundleJsonOpenFailure, } from "./bundle-config-shared.js";
import { CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH, CODEX_BUNDLE_MANIFEST_RELATIVE_PATH, CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH, mergeBundlePathLists, normalizeBundlePathList, } from "./bundle-manifest.js";
const MANIFEST_PATH_BY_FORMAT = {
    claude: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
    codex: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
    cursor: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
};
const CLAUDE_PLUGIN_ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";
function resolveBundleMcpConfigPaths(params) {
    const declared = normalizeBundlePathList(params.raw.mcpServers);
    const defaults = fs.existsSync(path.join(params.rootDir, ".mcp.json")) ? [".mcp.json"] : [];
    if (params.bundleFormat === "claude") {
        return mergeBundlePathLists(defaults, declared);
    }
    return mergeBundlePathLists(defaults, declared);
}
export function extractMcpServerMap(raw) {
    if (!isRecord(raw)) {
        return {};
    }
    const nested = isRecord(raw.mcpServers)
        ? raw.mcpServers
        : isRecord(raw.servers)
            ? raw.servers
            : raw;
    if (!isRecord(nested)) {
        return {};
    }
    const result = {};
    for (const [serverName, serverRaw] of Object.entries(nested)) {
        if (!isRecord(serverRaw)) {
            continue;
        }
        result[serverName] = { ...serverRaw };
    }
    return result;
}
function isExplicitRelativePath(value) {
    return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");
}
function expandBundleRootPlaceholders(value, rootDir) {
    if (!value.includes(CLAUDE_PLUGIN_ROOT_PLACEHOLDER)) {
        return value;
    }
    return value.split(CLAUDE_PLUGIN_ROOT_PLACEHOLDER).join(rootDir);
}
function normalizeBundlePath(targetPath) {
    return path.normalize(path.resolve(targetPath));
}
function normalizeExpandedAbsolutePath(value) {
    return path.isAbsolute(value) ? path.normalize(value) : value;
}
function absolutizeBundleMcpServer(params) {
    const next = { ...params.server };
    if (typeof next.cwd !== "string" && typeof next.workingDirectory !== "string") {
        next.cwd = params.baseDir;
    }
    const command = next.command;
    if (typeof command === "string") {
        const expanded = expandBundleRootPlaceholders(command, params.rootDir);
        next.command = isExplicitRelativePath(expanded)
            ? path.resolve(params.baseDir, expanded)
            : normalizeExpandedAbsolutePath(expanded);
    }
    const cwd = next.cwd;
    if (typeof cwd === "string") {
        const expanded = expandBundleRootPlaceholders(cwd, params.rootDir);
        next.cwd = path.isAbsolute(expanded) ? expanded : path.resolve(params.baseDir, expanded);
    }
    const workingDirectory = next.workingDirectory;
    if (typeof workingDirectory === "string") {
        const expanded = expandBundleRootPlaceholders(workingDirectory, params.rootDir);
        next.workingDirectory = path.isAbsolute(expanded)
            ? path.normalize(expanded)
            : path.resolve(params.baseDir, expanded);
    }
    if (Array.isArray(next.args)) {
        next.args = next.args.map((entry) => {
            if (typeof entry !== "string") {
                return entry;
            }
            const expanded = expandBundleRootPlaceholders(entry, params.rootDir);
            if (!isExplicitRelativePath(expanded)) {
                return normalizeExpandedAbsolutePath(expanded);
            }
            return path.resolve(params.baseDir, expanded);
        });
    }
    if (isRecord(next.env)) {
        next.env = Object.fromEntries(Object.entries(next.env).map(([key, value]) => [
            key,
            typeof value === "string"
                ? normalizeExpandedAbsolutePath(expandBundleRootPlaceholders(value, params.rootDir))
                : value,
        ]));
    }
    return next;
}
function loadBundleFileBackedMcpConfig(params) {
    const rootDir = normalizeBundlePath(params.rootDir);
    const absolutePath = path.resolve(rootDir, params.relativePath);
    const opened = openBoundaryFileSync({
        absolutePath,
        rootPath: rootDir,
        boundaryLabel: "plugin root",
        rejectHardlinks: true,
    });
    if (!opened.ok) {
        return { mcpServers: {} };
    }
    try {
        const stat = fs.fstatSync(opened.fd);
        if (!stat.isFile()) {
            return { mcpServers: {} };
        }
        const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8"));
        const servers = extractMcpServerMap(raw);
        const baseDir = normalizeBundlePath(path.dirname(absolutePath));
        return {
            mcpServers: Object.fromEntries(Object.entries(servers).map(([serverName, server]) => [
                serverName,
                absolutizeBundleMcpServer({ rootDir, baseDir, server }),
            ])),
        };
    }
    finally {
        fs.closeSync(opened.fd);
    }
}
function loadBundleInlineMcpConfig(params) {
    if (!isRecord(params.raw.mcpServers)) {
        return { mcpServers: {} };
    }
    const baseDir = normalizeBundlePath(params.baseDir);
    const servers = extractMcpServerMap(params.raw.mcpServers);
    return {
        mcpServers: Object.fromEntries(Object.entries(servers).map(([serverName, server]) => [
            serverName,
            absolutizeBundleMcpServer({ rootDir: baseDir, baseDir, server }),
        ])),
    };
}
function loadBundleMcpConfig(params) {
    const manifestRelativePath = MANIFEST_PATH_BY_FORMAT[params.bundleFormat];
    const manifestLoaded = readBundleJsonObject({
        rootDir: params.rootDir,
        relativePath: manifestRelativePath,
        onOpenFailure: (failure) => resolveBundleJsonOpenFailure({
            failure,
            relativePath: manifestRelativePath,
            allowMissing: params.bundleFormat === "claude",
        }),
    });
    if (!manifestLoaded.ok) {
        return { config: { mcpServers: {} }, diagnostics: [manifestLoaded.error] };
    }
    let merged = { mcpServers: {} };
    const filePaths = resolveBundleMcpConfigPaths({
        raw: manifestLoaded.raw,
        rootDir: params.rootDir,
        bundleFormat: params.bundleFormat,
    });
    for (const relativePath of filePaths) {
        merged = applyMergePatch(merged, loadBundleFileBackedMcpConfig({
            rootDir: params.rootDir,
            relativePath,
        }));
    }
    merged = applyMergePatch(merged, loadBundleInlineMcpConfig({
        raw: manifestLoaded.raw,
        baseDir: params.rootDir,
    }));
    return { config: merged, diagnostics: [] };
}
export function inspectBundleMcpRuntimeSupport(params) {
    const support = inspectBundleServerRuntimeSupport({
        loaded: loadBundleMcpConfig(params),
        resolveServers: (config) => config.mcpServers,
    });
    return {
        hasSupportedStdioServer: support.hasSupportedServer,
        supportedServerNames: support.supportedServerNames,
        unsupportedServerNames: support.unsupportedServerNames,
        diagnostics: support.diagnostics,
    };
}
export function loadEnabledBundleMcpConfig(params) {
    return loadEnabledBundleConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        createEmptyConfig: () => ({ mcpServers: {} }),
        loadBundleConfig: loadBundleMcpConfig,
        createDiagnostic: (pluginId, message) => ({ pluginId, message }),
    });
}
