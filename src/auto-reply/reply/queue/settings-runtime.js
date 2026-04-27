import { getChannelPlugin } from "../../../channels/plugins/index.js";
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";
import { resolveQueueSettings as resolveQueueSettingsCore } from "./settings.js";
function resolvePluginDebounce(channelKey) {
    if (!channelKey) {
        return undefined;
    }
    const plugin = getChannelPlugin(channelKey);
    const value = plugin?.defaults?.queue?.debounceMs;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}
export function resolveQueueSettings(params) {
    const channelKey = normalizeOptionalLowercaseString(params.channel);
    return resolveQueueSettingsCore({
        ...params,
        pluginDebounceMs: params.pluginDebounceMs ?? resolvePluginDebounce(channelKey),
    });
}
