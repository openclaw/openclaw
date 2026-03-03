import { normalizeToolName } from "../agents/tool-policy.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import { loadOpenClawPlugins } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
const log = createSubsystemLogger("plugins");
const pluginToolMeta = new WeakMap();
export function getPluginToolMeta(tool) {
    return pluginToolMeta.get(tool);
}
function normalizeAllowlist(list) {
    return new Set((list ?? []).map(normalizeToolName).filter(Boolean));
}
function isOptionalToolAllowed(params) {
    if (params.allowlist.size === 0) {
        return false;
    }
    const toolName = normalizeToolName(params.toolName);
    if (params.allowlist.has(toolName)) {
        return true;
    }
    const pluginKey = normalizeToolName(params.pluginId);
    if (params.allowlist.has(pluginKey)) {
        return true;
    }
    return params.allowlist.has("group:plugins");
}
export function resolvePluginTools(params) {
    // Fast path: when plugins are effectively disabled, avoid discovery/jiti entirely.
    // This matters a lot for unit tests and for tool construction hot paths.
    const effectiveConfig = applyTestPluginDefaults(params.context.config ?? {}, process.env);
    const normalized = normalizePluginsConfig(effectiveConfig.plugins);
    if (!normalized.enabled) {
        return [];
    }
    const registry = loadOpenClawPlugins({
        config: effectiveConfig,
        workspaceDir: params.context.workspaceDir,
        logger: createPluginLoaderLogger(log),
    });
    const tools = [];
    const existing = params.existingToolNames ?? new Set();
    const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
    const allowlist = normalizeAllowlist(params.toolAllowlist);
    const blockedPlugins = new Set();
    for (const entry of registry.tools) {
        if (blockedPlugins.has(entry.pluginId)) {
            continue;
        }
        const pluginIdKey = normalizeToolName(entry.pluginId);
        if (existingNormalized.has(pluginIdKey)) {
            const message = `plugin id conflicts with core tool name (${entry.pluginId})`;
            if (!params.suppressNameConflicts) {
                log.error(message);
                registry.diagnostics.push({
                    level: "error",
                    pluginId: entry.pluginId,
                    source: entry.source,
                    message,
                });
            }
            blockedPlugins.add(entry.pluginId);
            continue;
        }
        let resolved = null;
        try {
            resolved = entry.factory(params.context);
        }
        catch (err) {
            log.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
            continue;
        }
        if (!resolved) {
            continue;
        }
        const listRaw = Array.isArray(resolved) ? resolved : [resolved];
        const list = entry.optional
            ? listRaw.filter((tool) => isOptionalToolAllowed({
                toolName: tool.name,
                pluginId: entry.pluginId,
                allowlist,
            }))
            : listRaw;
        if (list.length === 0) {
            continue;
        }
        const nameSet = new Set();
        for (const tool of list) {
            if (nameSet.has(tool.name) || existing.has(tool.name)) {
                const message = `plugin tool name conflict (${entry.pluginId}): ${tool.name}`;
                if (!params.suppressNameConflicts) {
                    log.error(message);
                    registry.diagnostics.push({
                        level: "error",
                        pluginId: entry.pluginId,
                        source: entry.source,
                        message,
                    });
                }
                continue;
            }
            nameSet.add(tool.name);
            existing.add(tool.name);
            pluginToolMeta.set(tool, {
                pluginId: entry.pluginId,
                optional: entry.optional,
            });
            tools.push(tool);
        }
    }
    return tools;
}
