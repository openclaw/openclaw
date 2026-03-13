import type { OriginatingChannelType } from "../templating.js";
import {
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

function normalizeProviderValue(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

/**
 * Known internal/synthetic provider values that should not be used as
 * the session's stable message channel.  These are set on `sessionCtx.Provider`
 * during heartbeat, cron-event and exec-event turns and would cause the
 * system prompt to differ from the session's real channel — breaking
 * Anthropic's prefix-based prompt cache.
 */
const INTERNAL_PROVIDER_VALUES = new Set([
  "heartbeat",
  "cron-event",
  "exec-event",
]);

function isInternalProviderValue(value: string | undefined): boolean {
  return Boolean(value && INTERNAL_PROVIDER_VALUES.has(value.trim().toLowerCase()));
}

/**
 * Resolve a stable message channel for system prompt construction.
 *
 * Priority chain:
 *   1. OriginatingChannel — explicit reply routing context
 *   2. sessionEntry.lastChannel — persisted real channel (survives heartbeat/cron turns)
 *   3. sessionCtx.Provider — fallback for new sessions
 *
 * Steps 1 and 2 skip internal/synthetic values (webchat, heartbeat, cron-event, …)
 * so that prompt cache prefixes remain stable across turn types.
 */
export function resolveOriginMessageProvider(params: {
  originatingChannel?: OriginatingChannelType;
  lastChannel?: string;
  provider?: string;
}): string | undefined {
  // 1. Explicit originating channel (set by reply routing)
  const originating = normalizeProviderValue(params.originatingChannel);
  if (originating && !isInternalMessageChannel(originating) && !isInternalProviderValue(originating)) {
    return originating;
  }

  // 2. Session's last known real channel (survives heartbeat/cron turns)
  if (params.lastChannel) {
    const normalized = normalizeMessageChannel(params.lastChannel);
    if (normalized && !isInternalMessageChannel(normalized) && !isInternalProviderValue(normalized)) {
      return normalized;
    }
  }

  // 3. Fallback to per-turn provider (existing behavior for new sessions)
  return normalizeProviderValue(params.provider);
}

export function resolveOriginMessageTo(params: {
  originatingTo?: string;
  to?: string;
}): string | undefined {
  return params.originatingTo ?? params.to;
}

export function resolveOriginAccountId(params: {
  originatingAccountId?: string;
  accountId?: string;
}): string | undefined {
  return params.originatingAccountId ?? params.accountId;
}
