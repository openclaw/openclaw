/** Operator CLI for AI safety event taxonomy observability. */
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { callGateway } from "../gateway/call.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import type { SafetyEventRecord, SafetyEventSeverity } from "../infra/safety-event-store.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

const DEFAULT_SAFETY_LIMIT = 100;
const MAX_SAFETY_LIMIT = 500;

export type SafetyEventsCommandOptions = {
  type?: string;
  session?: string;
  since?: string;
  limit?: string;
  severity?: SafetyEventSeverity;
  cursor?: string;
  json?: boolean;
};

type SafetyEventsListResult = {
  events: SafetyEventRecord[];
  nextCursor?: string;
};

function parseSafetyLimit(value: string | undefined): number {
  if (!value) {
    return DEFAULT_SAFETY_LIMIT;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined || parsed > MAX_SAFETY_LIMIT) {
    throw new Error(`--limit must be between 1 and ${MAX_SAFETY_LIMIT}.`);
  }
  return parsed;
}

/** Parse a human-friendly duration like "1h", "30m", "2d" into milliseconds. */
function parseSinceDuration(value: string): number {
  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(trimmed);
  if (!match) {
    throw new Error(`--since must be a duration like 1h, 30m, 2d, or 600s (got "${value}").`);
  }
  const n = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
    case "d":
      return n * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unrecognised duration unit in "${value}".`);
  }
}

function severityBadge(severity: SafetyEventSeverity): string {
  switch (severity) {
    case "critical":
      return "[CRIT]";
    case "high":
      return "[HIGH]";
    case "medium":
      return "[ MED]";
    case "low":
      return "[ LOW]";
    case "info":
      return "[INFO]";
    default:
      return `[${String(severity).toUpperCase().slice(0, 4).padStart(4)}]`;
  }
}

function short(value: string | undefined, maxChars: number): string {
  if (!value) {
    return "-";
  }
  const sanitized = sanitizeTerminalText(value);
  if (!sanitized) {
    return "-";
  }
  if (sanitized.length <= maxChars) {
    return sanitized;
  }
  return `${sanitized.slice(0, maxChars - 1)}…`;
}

function formatSafetyRows(events: SafetyEventRecord[]): string[] {
  return events
    .toSorted((a, b) => b.sequence - a.sequence)
    .map((event) => {
      const ts = timestampMsToIsoString(event.recordedAt);
      const badge = severityBadge(event.severity);
      const type = short(event.type, 40);
      const msg = short(event.message, 60);
      const session = event.sessionId ? short(event.sessionId, 16) : "-";
      return `${ts}  ${badge}  ${type.padEnd(40)}  ${session.padEnd(16)}  ${msg}`;
    });
}

/** Query one stable page of AI safety events. JSON output is a bounded export. */
export async function safetyEventsCommand(
  options: SafetyEventsCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const sinceMs = options.since !== undefined ? parseSinceDuration(options.since) : undefined;
  const params: Record<string, unknown> = {
    limit: parseSafetyLimit(options.limit),
    ...(options.type ? { eventType: options.type } : {}),
    ...(options.session ? { sessionId: options.session } : {}),
    ...(options.severity ? { severity: options.severity } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  };
  // `since` is client-side post-filter on recordedAt; the ring buffer stores
  // all events, so we request the full page and filter locally.
  const result = await callGateway<SafetyEventsListResult>({
    method: "safety.events.list",
    params,
  });

  let { events } = result;
  if (sinceMs !== undefined) {
    const cutoff = Date.now() - sinceMs;
    events = events.filter((e) => e.recordedAt >= cutoff);
  }

  if (options.json) {
    writeRuntimeJson(runtime, { ...result, events });
    return;
  }

  if (events.length === 0) {
    runtime.log("No AI safety events found.");
    return;
  }

  runtime.log(
    `${"RECORDED AT".padEnd(24)}  ${"SEV".padEnd(6)}  ${"TYPE".padEnd(40)}  ${"SESSION".padEnd(16)}  MESSAGE`,
  );
  runtime.log("─".repeat(140));
  for (const row of formatSafetyRows(events)) {
    runtime.log(row);
  }
  if (result.nextCursor) {
    runtime.log(`\nMore records available: --cursor ${result.nextCursor}`);
  }
}
