import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPlugin } from "../../../channels/plugins/index.js";
import { normalizeQueueDebounce, resolveQueueSettingsCore } from "./settings.js";
import type { QueueSettings, ResolveQueueSettingsParams } from "./types.js";

/** Resolves queue settings with channel plugin defaults layered into core config. */
export function resolveQueueSettings(params: ResolveQueueSettingsParams): QueueSettings {
  const channelKey = normalizeOptionalLowercaseString(params.channel);
  return resolveQueueSettingsCore({
    ...params,
    pluginDebounceMs:
      params.pluginDebounceMs ??
      normalizeQueueDebounce(
        channelKey ? getLoadedChannelPlugin(channelKey)?.defaults?.queue?.debounceMs : undefined,
      ),
  });
}
