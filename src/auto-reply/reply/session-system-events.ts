import { resolveUserTimezone } from "../../agents/date-time.js";
import {
  escapeInternalRuntimeContextDelimiters,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelSummary } from "../../infra/channel-summary.js";
import {
  formatUtcTimestamp,
  formatZonedTimestamp,
  resolveTimezone,
} from "../../infra/format-time/format-datetime.ts";
import { isExecCompletionEvent } from "../../infra/heartbeat-events-filter.js";
import {
  consumeSelectedSystemEventEntries,
  peekSystemEventEntries,
  type SystemEvent,
} from "../../infra/system-events.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

// Exclude user-facing exec-completion events so the heartbeat path can
// consume them via its own relay surface. `audience: "internal"` events
// always belong on this generic drain (which routes them to the
// INTERNAL_RUNTIME_CONTEXT wrap) regardless of text shape — otherwise an
// exec-shaped internal event (e.g. cron output literally starting with
// "Exec finished...") falls into a no-consumer hole: this filter would
// strand it for the heartbeat path, but the heartbeat exec/consume
// selectors now skip internal events. The audience field is the source
// of truth for routing; text-shape only matters for user-facing events.
const selectGenericSystemEvents = (events: readonly SystemEvent[]): SystemEvent[] =>
  events.filter((event) => event.audience === "internal" || !isExecCompletionEvent(event.text));

/** Drain queued system events, format as `System:` lines, return the block (or undefined). */
export async function drainFormattedSystemEvents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  isMainSession: boolean;
  isNewSession: boolean;
}): Promise<string | undefined> {
  const compactSystemEvent = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }
    const lower = normalizeLowercaseStringOrEmpty(trimmed);
    if (lower.includes("reason periodic")) {
      return null;
    }
    // Filter out the actual heartbeat prompt, but not cron jobs that mention "heartbeat".
    // The heartbeat prompt starts with "Read HEARTBEAT.md" - cron payloads won't match this.
    if (lower.startsWith("read heartbeat.md")) {
      return null;
    }
    if (lower.includes("heartbeat poll") || lower.includes("heartbeat wake")) {
      return null;
    }
    if (trimmed.startsWith("Node:")) {
      return trimmed.replace(/ · last input [^·]+/i, "").trim();
    }
    return trimmed;
  };

  const resolveSystemEventTimezone = (cfg: OpenClawConfig) => {
    const raw = normalizeOptionalString(cfg.agents?.defaults?.envelopeTimezone);
    if (!raw) {
      return { mode: "local" as const };
    }
    const lowered = normalizeLowercaseStringOrEmpty(raw);
    if (lowered === "utc" || lowered === "gmt") {
      return { mode: "utc" as const };
    }
    if (lowered === "local" || lowered === "host") {
      return { mode: "local" as const };
    }
    if (lowered === "user") {
      return {
        mode: "iana" as const,
        timeZone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
      };
    }
    const explicit = resolveTimezone(raw);
    return explicit ? { mode: "iana" as const, timeZone: explicit } : { mode: "local" as const };
  };

  const formatSystemEventTimestamp = (ts: number, cfg: OpenClawConfig) => {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
      return "unknown-time";
    }
    const zone = resolveSystemEventTimezone(cfg);
    if (zone.mode === "utc") {
      return formatUtcTimestamp(date, { displaySeconds: true });
    }
    if (zone.mode === "local") {
      return formatZonedTimestamp(date, { displaySeconds: true }) ?? "unknown-time";
    }
    return (
      formatZonedTimestamp(date, { timeZone: zone.timeZone, displaySeconds: true }) ??
      "unknown-time"
    );
  };

  const userFacingLines: string[] = [];
  const internalLines: string[] = [];
  // Exec completions have a dedicated heartbeat prompt; leave those entries queued
  // so the heartbeat path can consume and deliver them.
  const queued = consumeSelectedSystemEventEntries(
    params.sessionKey,
    selectGenericSystemEvents(peekSystemEventEntries(params.sessionKey)),
  );
  for (const event of queued) {
    const compacted = compactSystemEvent(event.text);
    if (!compacted) {
      continue;
    }
    const prefix = event.trusted === false ? "System (untrusted)" : "System";
    const timestamp = `[${formatSystemEventTimestamp(event.ts, params.cfg)}]`;
    const eventLines = compacted
      .split("\n")
      .map((subline, index) => `${prefix}: ${index === 0 ? `${timestamp} ` : ""}${subline}`);
    if ((event.audience ?? "user-facing") === "internal") {
      internalLines.push(...eventLines);
    } else {
      userFacingLines.push(...eventLines);
    }
  }
  const systemLines: string[] = [...userFacingLines];
  if (internalLines.length > 0) {
    // Wrap internal-audience events in the runtime-context delimiters so the
    // agent runtime sees the content but user-facing surfaces strip it via
    // the existing stripInternalRuntimeContext consumers. Framing matches
    // `formatAgentInternalEventsForPrompt` in `src/agents/internal-events.ts`
    // (BEGIN, header, blank line, body, END): the header line tells the
    // model the wrapped block is runtime context, not user-authored, so it
    // should not echo the contents back into its reply.
    systemLines.push(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    systemLines.push("OpenClaw runtime context (internal):");
    systemLines.push(
      "This context is runtime-generated, not user-authored. Keep internal details private.",
    );
    systemLines.push("");
    systemLines.push(escapeInternalRuntimeContextDelimiters(internalLines.join("\n")));
    systemLines.push(INTERNAL_RUNTIME_CONTEXT_END);
  }
  if (params.isMainSession && params.isNewSession) {
    const summary = await buildChannelSummary(params.cfg);
    if (summary.length > 0) {
      systemLines.unshift(
        ...summary.flatMap((line) => line.split("\n").map((subline) => `System: ${subline}`)),
      );
    }
  }
  if (systemLines.length === 0) {
    return undefined;
  }

  // Each sub-line gets its own prefix so continuation lines can't be mistaken
  // for regular user content.
  return systemLines.join("\n");
}
