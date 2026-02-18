import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/types.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.ts";

/**
 * Cron jobs inject "Current time: ..." into their messages.
 * Skip injection for those.
 */
const CRON_TIME_PATTERN = /Current time: /;

/**
 * Matches a leading `[... YYYY-MM-DD HH:MM ...]` envelope — either from
 * channel plugins or from a previous injection. Uses the same YYYY-MM-DD
 * HH:MM format as {@link formatZonedTimestamp}, so detection stays in sync
 * with the formatting.
 */
const TIMESTAMP_ENVELOPE_PATTERN = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

export interface TimestampInjectionOptions {
  timezone?: string;
  now?: Date;
}

/**
 * Injects a compact timestamp prefix into a message if one isn't already
 * present. Uses the same `YYYY-MM-DD HH:MM TZ` format as channel envelope
 * timestamps ({@link formatZonedTimestamp}), keeping token cost low (~7
 * tokens) and format consistent across all agent contexts.
 *
 * Used by the gateway `agent` and `chat.send` handlers to give TUI, web,
 * spawned subagents, `sessions_send`, and heartbeat wake events date/time
 * awareness — without modifying the system prompt (which is cached).
 *
 * NOTE: Timestamps are rounded to 5-minute intervals to maintain prompt cache
 * compatibility with Anthropic. Without rounding, each request would have a
 * unique timestamp, breaking the cache and causing 10x higher costs.
 *
 * Channel messages (Discord, Telegram, etc.) already have timestamps via
 * envelope formatting and take a separate code path — they never reach
 * these handlers, so there is no double-stamping risk. The detection
 * pattern is a safety net for edge cases.
 *
 * @see https://github.com/moltbot/moltbot/issues/3658
 */
export function injectTimestamp(message: string, opts?: TimestampInjectionOptions): string {
  if (!message.trim()) {
    return message;
  }

  // Already has an envelope or injected timestamp
  if (TIMESTAMP_ENVELOPE_PATTERN.test(message)) {
    return message;
  }

  // Already has a cron-injected timestamp
  if (CRON_TIME_PATTERN.test(message)) {
    return message;
  }

  const now = opts?.now ?? new Date();
  // Round to 5-minute intervals to maintain prompt cache compatibility
  const fiveMinutes = 5 * 60 * 1000;
  const rounded = new Date(Math.floor(now.getTime() / fiveMinutes) * fiveMinutes);
  const timezone = opts?.timezone ?? "UTC";

  const formatted = formatZonedTimestamp(rounded, { timeZone: timezone });
  if (!formatted) {
    return message;
  }

  // 3-letter DOW: small models (8B) can't reliably derive day-of-week from
  // a date, and may treat a bare "Wed" as a typo. Costs ~1 token.
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(
    rounded,
  );

  return `[${dow} ${formatted}] ${message}`;
}

/**
 * Build TimestampInjectionOptions from an OpenClawConfig.
 */
export function timestampOptsFromConfig(cfg: OpenClawConfig): TimestampInjectionOptions {
  return {
    timezone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
  };
}
