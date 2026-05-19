import { getLoadedChannelPlugin } from "../../../channels/plugins/index.js";
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";
import { resolveQueueSettings as resolveQueueSettingsCore } from "./settings.js";
import type { QueueSettings, ResolveQueueSettingsParams } from "./types.js";

function resolvePluginDebounce(channelKey: string | undefined): number | undefined {
  if (!channelKey) {
    return undefined;
  }
  const plugin = getLoadedChannelPlugin(channelKey);
  const value = plugin?.defaults?.queue?.debounceMs;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function shouldResolvePluginDebounce(params: ResolveQueueSettingsParams): boolean {
  return params.pluginDebounceMs === undefined && params.cfg.plugins?.enabled !== false;
}

export function resolveQueueSettings(params: ResolveQueueSettingsParams): QueueSettings {
  const channelKey = normalizeOptionalLowercaseString(params.channel);
  return resolveQueueSettingsCore({
    ...params,
    pluginDebounceMs: shouldResolvePluginDebounce(params)
      ? resolvePluginDebounce(channelKey)
      : params.pluginDebounceMs,
  });
}
