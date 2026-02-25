import type { OriginatingChannelType } from "../templating.js";
import {
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

function normalizeProviderValue(value?: string): string | undefined {
  return (normalizeMessageChannel(value) ?? value?.trim().toLowerCase()) || undefined;
}

/**
 * Synthetic provider values that should not overwrite the session's stable
 * message channel. These are injected for heartbeat/cron/exec turns and would
 * otherwise cause system prompts and tool context to drift away from the
 * session's real channel, breaking prompt-cache reuse.
 */
const SYNTHETIC_PROVIDER_VALUES = new Set([
  "heartbeat",
  "cron-event",
  "exec-event",
]);

function isSyntheticProviderValue(value: string | undefined): boolean {
  return Boolean(value && SYNTHETIC_PROVIDER_VALUES.has(value.trim().toLowerCase()));
}

/**
 * Resolve a stable message channel for prompt + tool-context construction.
 *
 * Priority chain:
 *   1. OriginatingChannel — explicit reply routing context
 *   2. sessionEntry.lastChannel — persisted channel (survives heartbeat/cron turns)
 *   3. sessionCtx.Provider — fallback for new sessions
 *
 * Internal webchat turns should not overwrite a known external session channel,
 * but internal-only sessions should keep `webchat` stable instead of degrading
 * to synthetic provider values like `heartbeat`.
 */
export function resolveOriginMessageProvider(params: {
  originatingChannel?: OriginatingChannelType;
  lastChannel?: string;
  provider?: string;
}): string | undefined {
  const originating = normalizeProviderValue(params.originatingChannel);
  const lastChannel = normalizeProviderValue(params.lastChannel);

  // 1. Explicit originating channel (set by reply routing)
  if (originating && !isSyntheticProviderValue(originating)) {
    if (!isInternalMessageChannel(originating)) {
      return originating;
    }
    if (
      !lastChannel ||
      isInternalMessageChannel(lastChannel) ||
      isSyntheticProviderValue(lastChannel)
    ) {
      return originating;
    }
  }

  // 2. Session's last known stable channel (survives heartbeat/cron turns)
  if (lastChannel && !isSyntheticProviderValue(lastChannel)) {
    return lastChannel;
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
