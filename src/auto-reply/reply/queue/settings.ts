import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizePersistedQueueMode,
  normalizeQueueDropPolicy,
  normalizeQueueMode,
} from "./normalize.js";
import { DEFAULT_QUEUE_CAP, DEFAULT_QUEUE_DEBOUNCE_MS, DEFAULT_QUEUE_DROP } from "./state.js";
import type { QueueSettings, ResolveQueueSettingsParams } from "./types.js";

export function normalizeQueueDebounce(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

export function resolveQueueSettingsCore(params: ResolveQueueSettingsParams): QueueSettings {
  const channelKey = normalizeOptionalLowercaseString(params.channel);
  const queueCfg = params.cfg.messages?.queue;
  const providerModeRaw = channelKey ? queueCfg?.byChannel?.[channelKey] : undefined;
  const resolvedMode =
    params.inlineMode ??
    normalizePersistedQueueMode(params.sessionEntry?.queueMode) ??
    normalizeQueueMode(providerModeRaw) ??
    normalizeQueueMode(queueCfg?.mode) ??
    "steer";
  const debounceRaw =
    params.inlineOptions?.debounceMs ??
    params.sessionEntry?.queueDebounceMs ??
    normalizeQueueDebounce(channelKey ? queueCfg?.debounceMsByChannel?.[channelKey] : undefined) ??
    params.pluginDebounceMs ??
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
  };
}
