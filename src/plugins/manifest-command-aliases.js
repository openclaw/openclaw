import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
export function normalizeManifestCommandAliases(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const normalized = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            const name = normalizeOptionalString(entry) ?? "";
            if (name) {
                normalized.push({ name });
            }
            continue;
        }
        if (!isRecord(entry)) {
            continue;
        }
        const name = normalizeOptionalString(entry.name) ?? "";
        if (!name) {
            continue;
        }
        const kind = entry.kind === "runtime-slash" ? entry.kind : undefined;
        const cliCommand = normalizeOptionalString(entry.cliCommand) ?? "";
        normalized.push({
            name,
            ...(kind ? { kind } : {}),
            ...(cliCommand ? { cliCommand } : {}),
        });
    }
    return normalized.length > 0 ? normalized : undefined;
}
export function resolveManifestCommandAliasOwnerInRegistry(params) {
    const normalizedCommand = normalizeOptionalLowercaseString(params.command);
    if (!normalizedCommand) {
        return undefined;
    }
    const commandIsPluginId = params.registry.plugins.some((plugin) => normalizeOptionalLowercaseString(plugin.id) === normalizedCommand);
    if (commandIsPluginId) {
        return undefined;
    }
    for (const plugin of params.registry.plugins) {
        const alias = plugin.commandAliases?.find((entry) => normalizeOptionalLowercaseString(entry.name) === normalizedCommand);
        if (alias) {
            return { ...alias, pluginId: plugin.id };
        }
    }
    return undefined;
}
