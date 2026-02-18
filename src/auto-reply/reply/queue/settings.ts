import { getChannelPlugin } from "../../../channels/plugins/index.js";
import type { InboundDebounceByProvider } from "../../../config/types.messages.js";
import { normalizeQueueDropPolicy, normalizeQueueMode } from "./normalize.js";
import { DEFAULT_QUEUE_CAP, DEFAULT_QUEUE_DEBOUNCE_MS, DEFAULT_QUEUE_DROP } from "./state.js";
import type { QueueMode, QueueSettings, ResolveQueueSettingsParams, SteerTriggerMatch } from "./types.js";

function defaultQueueModeForChannel(_channel?: string): QueueMode {
  return "collect";
}

/** Resolve per-channel debounce override from debounceMsByChannel map. */
function resolveChannelDebounce(
  byChannel: InboundDebounceByProvider | undefined,
  channelKey: string | undefined,
): number | undefined {
  if (!channelKey || !byChannel) {
    return undefined;
  }
  const value = byChannel[channelKey];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function resolvePluginDebounce(channelKey: string | undefined): number | undefined {
  if (!channelKey) {
    return undefined;
  }
  const plugin = getChannelPlugin(channelKey);
  const value = plugin?.defaults?.queue?.debounceMs;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

/**
 * Check whether the prompt starts with any of the configured steer triggers.
 * The match is case-insensitive and the trigger is stripped from the returned prompt.
 */
export function matchSteerTrigger(
  prompt: string | undefined,
  triggers: string[] | undefined,
): SteerTriggerMatch {
  if (!prompt || !triggers || triggers.length === 0) {
    return { matched: false, cleanedPrompt: prompt ?? "" };
  }
  const trimmed = prompt.trimStart();
  for (const trigger of triggers) {
    if (!trigger) continue;
    if (trimmed.toLowerCase().startsWith(trigger.toLowerCase())) {
      const cleanedPrompt = trimmed.slice(trigger.length).trimStart();
      return { matched: true, cleanedPrompt };
    }
  }
  return { matched: false, cleanedPrompt: prompt };
}

export function resolveQueueSettings(params: ResolveQueueSettingsParams): QueueSettings & { cleanedPrompt?: string } {
  const channelKey = params.channel?.trim().toLowerCase();
  const queueCfg = params.cfg.messages?.queue;
  const providerModeRaw =
    channelKey && queueCfg?.byChannel
      ? (queueCfg.byChannel as Record<string, string | undefined>)[channelKey]
      : undefined;

  // Check per-message steer trigger before resolving the global mode.
  // A trigger match forces `steer` for this message only (one-shot override).
  const triggerMatch = matchSteerTrigger(params.prompt, queueCfg?.steerTriggers);

  const resolvedMode: QueueMode =
    // Inline directive (e.g. `/queue steer` in the message) has highest priority.
    params.inlineMode ??
    // A matched steer trigger overrides session + config queue modes.
    (triggerMatch.matched ? "steer" : undefined) ??
    normalizeQueueMode(params.sessionEntry?.queueMode) ??
    normalizeQueueMode(providerModeRaw) ??
    normalizeQueueMode(queueCfg?.mode) ??
    defaultQueueModeForChannel(channelKey);

  const debounceRaw =
    params.inlineOptions?.debounceMs ??
    params.sessionEntry?.queueDebounceMs ??
    resolveChannelDebounce(queueCfg?.debounceMsByChannel, channelKey) ??
    resolvePluginDebounce(channelKey) ??
    queueCfg?.debounceMs ??
    DEFAULT_QUEUE_DEBOUNCE_MS;
  const capRaw =
    params.inlineOptions?.cap ??
    params.sessionEntry?.queueCap ??
    queueCfg?.cap ??
    DEFAULT_QUEUE_CAP;
  const dropRaw =
    params.inlineOptions?.dropPolicy ??
    params.sessionEntry?.queueDrop ??
    normalizeQueueDropPolicy(queueCfg?.drop) ??
    DEFAULT_QUEUE_DROP;
  return {
    mode: resolvedMode,
    debounceMs: typeof debounceRaw === "number" ? Math.max(0, debounceRaw) : undefined,
    cap: typeof capRaw === "number" ? Math.max(1, Math.floor(capRaw)) : undefined,
    dropPolicy: dropRaw,
    // Pass the cleaned prompt back so callers can strip the trigger prefix.
    cleanedPrompt: triggerMatch.matched ? triggerMatch.cleanedPrompt : undefined,
  };
}
