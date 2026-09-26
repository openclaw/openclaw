import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/types.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.ts";

// Cron prompts already carry their own clock.
const CRON_TIME_MARKER = "Current time: ";

// Match channel envelopes and existing prefixes using formatZonedTimestamp's date format.
const TIMESTAMP_ENVELOPE_PATTERN = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

interface TimestampInjectionOptions {
  timezone?: string;
  now?: Date;
  includeTimestamp?: boolean;
}

/** Stamp historical messages with their own arrival time; return undefined for invalid zones. */
export function buildTimestampPrefix(
  date: Date,
  opts?: Pick<TimestampInjectionOptions, "timezone">,
): string | undefined {
  // The weekday keeps date reasoning reliable without another Intl formatter.
  const formatted = formatZonedTimestamp(date, {
    timeZone: opts?.timezone ?? "UTC",
    displayWeekday: true,
  });
  return formatted ? `[${formatted}] ` : undefined;
}

/** CLI prompts need a clock; embedded messages are stamped once at the LLM boundary. */
export function injectTimestamp(message: string, opts?: TimestampInjectionOptions): string {
  if (opts?.includeTimestamp === false) {
    return message;
  }
  if (!message.trim()) {
    return message;
  }

  if (TIMESTAMP_ENVELOPE_PATTERN.test(message)) {
    return message;
  }

  if (message.includes(CRON_TIME_MARKER)) {
    return message;
  }

  const now = opts?.now ?? new Date();
  const prefix = buildTimestampPrefix(now, opts);
  if (!prefix) {
    return message;
  }

  return `${prefix}${message}`;
}

export function timestampOptsFromConfig(cfg: OpenClawConfig): TimestampInjectionOptions {
  return {
    timezone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
    includeTimestamp: true,
  };
}
