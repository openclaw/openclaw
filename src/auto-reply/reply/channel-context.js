import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../../shared/string-coerce.js";
export function resolveCommandSurfaceChannel(params) {
    const channel = params.ctx.OriginatingChannel ??
        params.command.channel ??
        params.ctx.Surface ??
        params.ctx.Provider;
    return normalizeOptionalLowercaseString(channel) ?? "";
}
export function resolveChannelAccountId(params) {
    const accountId = normalizeOptionalString(params.ctx.AccountId) ?? "";
    if (accountId) {
        return accountId;
    }
    const channel = resolveCommandSurfaceChannel(params);
    const plugin = getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === channel)?.plugin;
    const configuredDefault = normalizeOptionalString(plugin?.config.defaultAccountId?.(params.cfg));
    return configuredDefault || "default";
}
