import { normalizeQueueMode } from "../../../../src/auto-reply/reply/queue/normalize.js";
import type { QueueMode } from "../../../../src/auto-reply/reply/queue/types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../../src/utils/message-channel-constants.js";
import { normalizeChatFollowUpModeOverride, type ChatFollowUpMode } from "../../app/settings.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizedQueueMode(value: unknown): QueueMode | undefined {
  return typeof value === "string" ? normalizeQueueMode(value) : undefined;
}

/** Matches resolveQueueSettings precedence for the Control UI's webchat channel. */
export function resolveControlUiServerQueueMode(runtimeConfig: unknown): QueueMode {
  const messages = record(record(runtimeConfig)?.messages);
  const queue = record(messages?.queue);
  const byChannel = record(queue?.byChannel);
  return (
    normalizedQueueMode(byChannel?.[INTERNAL_MESSAGE_CHANNEL]) ??
    normalizedQueueMode(queue?.mode) ??
    "steer"
  );
}

/** The browser only chooses between immediate steering and its durable local queue. */
export function resolveControlUiFollowUpMode(
  override: unknown,
  serverMode: QueueMode | undefined,
): ChatFollowUpMode {
  return (
    normalizeChatFollowUpModeOverride(override) ?? (serverMode === "steer" ? "steer" : "queue")
  );
}
