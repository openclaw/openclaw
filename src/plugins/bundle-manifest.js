import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { matchBoundaryFileOpenFailure, openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import { DEFAULT_PLUGIN_ENTRY_CANDIDATES, PLUGIN_MANIFEST_FILENAME } from "./manifest.js";
export const CODEX_BUNDLE_MANIFEST_RELATIVE_PATH = ".codex-plugin/plugin.json";
export const CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH = ".claude-plugin/plugin.json";
export const CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH = ".cursor-plugin/plugin.json";
function normalizePathList(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
    }
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry) => Boolean(entry));
}
export function normalizeBundlePathList(value) {
    return Array.from(new Set(normalizePathList(value)));
}
export function mergeBundlePathLists(...groups) {
    const merged = [];
    const seen = new Set();
    for (const group of groups) {
        for (const entry of group) {
            if (seen.has(entry)) {
                continue;
            }
            seen.add(entry);
            merged.push(entry);
        }
    }
    return merged;
}
function hasInlineCapabilityValue(value) {
    if (typeof value === "string") {
        return value.trim().length > 0;
    }
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (isRecord(value)) {
        return Object.keys(value).length > 0;
    }
    return value === true;
}
function slugifyPluginId(raw, rootDir) {
    const fallback = path.basename(rootDir);
    const source = normalizeLowercaseStringOrEmpty(raw) || normalizeLowercaseStringOrEmpty(fallback);
    const slug = source
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "bundle-plugin";
}
function loadBundleManifestFile(params) {
    const manifestPath = path.join(params.rootDir, params.manifestRelativePath);
    const opened = openBoundaryFileSync({
        absolutePath: manifestPath,
        rootPath: params.rootDir,
        boundaryLabel: "plugin root",
        rejectHardlinks: params.rejectHardlinks,
    });
    if (!opened.ok) {
        return matchBoundaryFileOpenFailure(opened, {
            path: () => {
                if (params.allowMissing) {
                    return { ok: true, raw: {}, manifestPath };
                }
                return { ok: false, error: `plugin manifest not found: ${manifestPath}`, manifestPath };
            },
            fallback: (failure) => ({
                ok: false,
                error: `unsafe plugin manifest path: ${manifestPath} (${failure.reason})`,
                manifestPath,
            }),
        });
    }
    try {
        const raw = JSON5.parse(fs.readFileSync(opened.fd, "utf-8"));
        if (!isRecord(raw)) {
            return { ok: false, error: "plugin manifest must be an object", manifestPath };
        }
        return { ok: true, raw, manifestPath };
    }
    catch (err) {
        return {
            ok: false,
            error: `failed to parse plugin manifest: ${String(err)}`,
            manifestPath,
        };
    }
    finally {
        fs.closeSync(opened.fd);
    }
}
function resolveCodexSkillDirs(raw, rootDir) {
    const declared = normalizeBundlePathList(raw.skills);
    if (declared.length > 0) {
        return declared;
    }
    return fs.existsSync(path.join(rootDir, "skills")) ? ["skills"] : [];
}
function resolveCodexHookDirs(raw, rootDir) {
    const declared = normalizeBundlePathList(raw.hooks);
    if (declared.length > 0) {
        return declared;
    }
    return fs.existsSync(path.join(rootDir, "hooks")) ? ["hooks"] : [];
}
function resolveCursorSkillsRootDirs(raw, rootDir) {
    const declared = normalizeBundlePathList(raw.skills);
    const defaults = fs.existsSync(path.join(rootDir, "skills")) ? ["skills"] : [];
    return mergeBundlePathLists(defaults, declared);
}
function resolveCursorCommandRootDirs(raw, rootDir) {
    const declared = normalizeBundlePathList(raw.commands);
    const defaults = fs.existsSync(path.join(rootDir, ".cursor", "commands"))
        ? [".cursor/commands"]
        : [];
    return mergeBundlePathLists(defaults, declared);
}
function resolveCursorSkillDirs(raw, rootDir) {
    return mergeBundlePathLists(resolveCursorSkillsRootDirs(raw, rootDir), resolveCursorCommandRootDirs(raw, rootDir));
}
function resolveCursorAgentDirs(raw, rootDir) {
    const declared = normalizeBundlePathList(raw.subagents ?? raw.agents);
    const defaults = fs.existsSync(path.join(rootDir, ".cursor", "agents")) ? [".cursor/agents"] : [];
    return mergeBundlePathLists(defaults, declared);
}
function hasCursorHookCapability(raw, rootDir) {
    return (hasInlineCapabilityValue(raw.hooks) ||
        fs.existsSync(path.join(rootDir, ".cursor", "hooks.json")));
}
function hasCursorRulesCapability(raw, rootDir) {
    return (hasInlineCapabilityValue(raw.rules) || fs.existsSync(path.join(rootDir, ".cursor", "rules")));
}
function hasCursorMcpCapability(raw, rootDir) {
    return hasInlineCapabilityValue(raw.mcpServers) || fs.existsSync(path.join(rootDir, ".mcp.json"));
}
function resolveClaudeComponentPaths(raw, key, rootDir, defaults) {
    const declared = normalizeBundlePathList(raw[key]);
    const existingDefaults = defaults.filter((candidate) => fs.existsSync(path.join(rootDir, candidate)));
    return mergeBundlePathLists(existingDefaults, declared);
}
function resolveClaudeSkillsRootDirs(raw, rootDir) {
    return resolveClaudeComponentPaths(raw, "skills", rootDir, ["skills"]);
}
function resolveClaudeCommandRootDirs(raw, rootDir) {
    return resolveClaudeComponentPaths(raw, "commands", rootDir, ["commands"]);
}
function resolveClaudeSkillDirs(raw, rootDir) {
    return mergeBundlePathLists(resolveClaudeSkillsRootDirs(raw, rootDir), resolveClaudeCommandRootDirs(raw, rootDir), resolveClaudeAgentDirs(raw, rootDir), resolveClaudeOutputStylePaths(raw, rootDir));
}
function resolveClaudeAgentDirs(raw, rootDir) {
    return resolveClaudeComponentPaths(raw, "agents", rootDir, ["agents"]);
}
function resolveClaudeHookPaths(raw, rootDir) {
    return resolveClaudeComponentPaths(raw, "hooks", rootDir, ["hooks/hooks.json"]);
}
function resolveClaudeMcpPaths(raw, rootDir) {
    return resolveClaudeComponentPaths(raw, "mcpServers", rootDir, [".mcp.json"]);
}
function resolveClaudeLspPaths(raw, rootDir) {
    return resolveClaudeComponentPaths(raw, "lspServers", rootDir, [".lsp.json"]);
}
function resolveClaudeOutputStylePaths(raw, rootDir) {
    return resolveClaudeComponentPaths(raw, "outputStyles", rootDir, ["output-styles"]);
}
function resolveClaudeSettingsFiles(_raw, rootDir) {
    return fs.existsSync(path.join(rootDir, "settings.json")) ? ["settings.json"] : [];
}
function hasClaudeHookCapability(raw, rootDir) {
    return hasInlineCapabilityValue(raw.hooks) || resolveClaudeHookPaths(raw, rootDir).length > 0;
}
function buildCodexCapabilities(raw, rootDir) {
    const capabilities = [];
    if (resolveCodexSkillDirs(raw, rootDir).length > 0) {
        capabilities.push("skills");
    }
    if (resolveCodexHookDirs(raw, rootDir).length > 0) {
        capabilities.push("hooks");
    }
    if (hasInlineCapabilityValue(raw.mcpServers) || fs.existsSync(path.join(rootDir, ".mcp.json"))) {
        capabilities.push("mcpServers");
    }
    if (hasInlineCapabilityValue(raw.apps) || fs.existsSync(path.join(rootDir, ".app.json"))) {
        capabilities.push("apps");
    }
    return capabilities;
}
function buildClaudeCapabilities(raw, rootDir) {
    const capabilities = [];
    if (resolveClaudeSkillDirs(raw, rootDir).length > 0) {
        capabilities.push("skills");
    }
    if (resolveClaudeCommandRootDirs(raw, rootDir).length > 0) {
        capabilities.push("commands");
    }
    if (resolveClaudeAgentDirs(raw, rootDir).length > 0) {
        capabilities.push("agents");
    }
    if (hasClaudeHookCapability(raw, rootDir)) {
        capabilities.push("hooks");
    }
    if (hasInlineCapabilityValue(raw.mcpServers) || resolveClaudeMcpPaths(raw, rootDir).length > 0) {
        capabilities.push("mcpServers");
    }
    if (hasInlineCapabilityValue(raw.lspServers) || resolveClaudeLspPaths(raw, rootDir).length > 0) {
        capabilities.push("lspServers");
    }
    if (hasInlineCapabilityValue(raw.outputStyles) ||
        resolveClaudeOutputStylePaths(raw, rootDir).length > 0) {
        capabilities.push("outputStyles");
    }
    if (resolveClaudeSettingsFiles(raw, rootDir).length > 0) {
        capabilities.push("settings");
    }
    return capabilities;
}
function buildCursorCapabilities(raw, rootDir) {
    const capabilities = [];
    if (resolveCursorSkillDirs(raw, rootDir).length > 0) {
        capabilities.push("skills");
    }
    if (resolveCursorCommandRootDirs(raw, rootDir).length > 0) {
        capabilities.push("commands");
    }
    if (resolveCursorAgentDirs(raw, rootDir).length > 0) {
        capabilities.push("agents");
    }
    if (hasCursorHookCapability(raw, rootDir)) {
        capabilities.push("hooks");
    }
    if (hasCursorRulesCapability(raw, rootDir)) {
        capabilities.push("rules");
    }
    if (hasCursorMcpCapability(raw, rootDir)) {
        capabilities.push("mcpServers");
    }
    return capabilities;
}
export function loadBundleManifest(params) {
    const rejectHardlinks = params.rejectHardlinks ?? true;
    const manifestRelativePath = params.bundleFormat === "codex"
        ? CODEX_BUNDLE_MANIFEST_RELATIVE_PATH
        : params.bundleFormat === "cursor"
            ? CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH
            : CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH;
    const loaded = loadBundleManifestFile({
        rootDir: params.rootDir,
        manifestRelativePath,
        rejectHardlinks,
        allowMissing: params.bundleFormat === "claude",
    });
    if (!loaded.ok) {
        return loaded;
    }
    const raw = loaded.raw;
    const interfaceRecord = isRecord(raw.interface) ? raw.interface : undefined;
    const name = normalizeOptionalString(raw.name);
    const description = normalizeOptionalString(raw.description) ??
        normalizeOptionalString(raw.shortDescription) ??
        normalizeOptionalString(interfaceRecord?.shortDescription);
    const version = normalizeOptionalString(raw.version);
    if (params.bundleFormat === "codex") {
        const skills = resolveCodexSkillDirs(raw, params.rootDir);
        const hooks = resolveCodexHookDirs(raw, params.rootDir);
        return {
            ok: true,
            manifest: {
                id: slugifyPluginId(name, params.rootDir),
                name,
                description,
                version,
                skills,
                settingsFiles: [],
                hooks,
                bundleFormat: "codex",
                capabilities: buildCodexCapabilities(raw, params.rootDir),
            },
            manifestPath: loaded.manifestPath,
        };
    }
    if (params.bundleFormat === "cursor") {
        return {
            ok: true,
            manifest: {
                id: slugifyPluginId(name, params.rootDir),
                name,
                description,
                version,
                skills: resolveCursorSkillDirs(raw, params.rootDir),
                settingsFiles: [],
                hooks: [],
                bundleFormat: "cursor",
                capabilities: buildCursorCapabilities(raw, params.rootDir),
            },
            manifestPath: loaded.manifestPath,
        };
    }
    return {
        ok: true,
        manifest: {
            id: slugifyPluginId(name, params.rootDir),
            name,
            description,
            version,
            skills: resolveClaudeSkillDirs(raw, params.rootDir),
            settingsFiles: resolveClaudeSettingsFiles(raw, params.rootDir),
            hooks: resolveClaudeHookPaths(raw, params.rootDir),
            bundleFormat: "claude",
            capabilities: buildClaudeCapabilities(raw, params.rootDir),
        },
        manifestPath: loaded.manifestPath,
    };
}
export function detectBundleManifestFormat(rootDir) {
    if (fs.existsSync(path.join(rootDir, CODEX_BUNDLE_MANIFEST_RELATIVE_PATH))) {
        return "codex";
    }
    if (fs.existsSync(path.join(rootDir, CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH))) {
        return "cursor";
    }
    if (fs.existsSync(path.join(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH))) {
        return "claude";
    }
    if (fs.existsSync(path.join(rootDir, PLUGIN_MANIFEST_FILENAME))) {
        return null;
    }
    if (DEFAULT_PLUGIN_ENTRY_CANDIDATES.some((candidate) => fs.existsSync(path.join(rootDir, candidate)))) {
        return null;
    }
    const manifestlessClaudeMarkers = [
        path.join(rootDir, "skills"),
        path.join(rootDir, "commands"),
        path.join(rootDir, "agents"),
        path.join(rootDir, "hooks", "hooks.json"),
        path.join(rootDir, ".mcp.json"),
        path.join(rootDir, ".lsp.json"),
        path.join(rootDir, "settings.json"),
    ];
    if (manifestlessClaudeMarkers.some((candidate) => fs.existsSync(candidate))) {
        return "claude";
    }
    return null;
}
