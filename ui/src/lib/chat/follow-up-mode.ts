import { normalizeQueueMode } from "../../../../src/auto-reply/reply/queue/normalize.js";
import type { QueueMode } from "../../../../src/auto-reply/reply/queue/types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../../src/utils/message-channel-constants.js";
import { normalizeChatFollowUpModeOverride, type ChatFollowUpMode } from "../../app/settings.js";

export type ControlUiFollowUpMode = ChatFollowUpMode | Exclude<QueueMode, "steer">;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizedQueueMode(value: unknown): QueueMode | undefined {
  return typeof value === "string" ? normalizeQueueMode(value) : undefined;
}

/** Matches resolveQueueSettings precedence for the current Control UI session. */
export function resolveControlUiServerQueueMode(
  runtimeConfig: unknown,
  sessionMode?: unknown,
): QueueMode {
  const messages = record(record(runtimeConfig)?.messages);
  const queue = record(messages?.queue);
  const byChannel = record(queue?.byChannel);
  return (
    normalizedQueueMode(sessionMode) ??
    normalizedQueueMode(byChannel?.[INTERNAL_MESSAGE_CHANNEL]) ??
    normalizedQueueMode(queue?.mode) ??
    "steer"
  );
}

/** Explicit browser choice wins; otherwise preserve the Gateway's full queue semantics. */
export function resolveControlUiFollowUpMode(
  override: unknown,
  serverMode: QueueMode | undefined,
): ControlUiFollowUpMode {
  return normalizeChatFollowUpModeOverride(override) ?? serverMode ?? "queue";
}
