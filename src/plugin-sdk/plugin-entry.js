import { emptyPluginConfigSchema } from "../plugins/config-schema.js";
import { createCachedLazyValueGetter } from "./lazy-value.js";
export { buildPluginConfigSchema, emptyPluginConfigSchema } from "../plugins/config-schema.js";
/**
 * Canonical entry helper for non-channel plugins.
 *
 * Use this for provider, tool, command, service, memory, and context-engine
 * plugins. Channel plugins should use `defineChannelPluginEntry(...)` from
 * `openclaw/plugin-sdk/core` so they inherit the channel capability wiring.
 */
export function definePluginEntry({ id, name, description, kind, configSchema = emptyPluginConfigSchema, reload, nodeHostCommands, securityAuditCollectors, register, }) {
    const getConfigSchema = createCachedLazyValueGetter(configSchema);
    return {
        id,
        name,
        description,
        ...(kind ? { kind } : {}),
        ...(reload ? { reload } : {}),
        ...(nodeHostCommands ? { nodeHostCommands } : {}),
        ...(securityAuditCollectors ? { securityAuditCollectors } : {}),
        get configSchema() {
            return getConfigSchema();
        },
        register,
    };
}
