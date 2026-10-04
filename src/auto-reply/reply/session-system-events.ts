import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelSummary } from "../../infra/channel-summary.js";
import {
  formatUtcTimestamp,
  formatZonedTimestamp,
  resolveTimezone,
} from "../../infra/format-time/format-datetime.ts";
import {
  isSystemEventStoreCurrent,
  resolveSystemEventQueueKey,
} from "../../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  isSystemEventTurnOwned,
  peekSystemEventEntries,
  type SystemEvent,
} from "../../infra/system-events.js";
import { acknowledgeSessionStateNotices } from "../../sessions/session-state-events.js";
import { decodeSessionStateNoticeContextKey } from "../../sessions/session-state-notices.js";

function compactSystemEvent(event: SystemEvent): string | null {
  const trimmed = event.text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("Node:")) {
    return trimmed.replace(/ · last input [^·]+/i, "").trim();
  }
  return trimmed;
}

function resolveSystemEventTimezone(cfg: OpenClawConfig) {
  const raw = normalizeOptionalString(cfg.agents?.defaults?.userTimezone);
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
}

function formatSystemEventTimestamp(ts: number, cfg: OpenClawConfig) {
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
    formatZonedTimestamp(date, { timeZone: zone.timeZone, displaySeconds: true }) ?? "unknown-time"
  );
}

/** Drain queued system events, format as `System:` lines, return the block text (or undefined). */
export async function drainFormattedSystemEvents(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  isMainSession: boolean;
  isNewSession: boolean;
  events?: readonly SystemEvent[];
  deferredEventIds?: readonly string[];
}): Promise<string | undefined> {
  const systemLines: string[] = [];
  const queueKey = resolveSystemEventQueueKey(params.sessionKey, params.agentId);
  // Producer-owned occurrences retain their own admission; ordinary notices
  // join the next context build regardless of their text.
  const queued = consumeSelectedSystemEventEntries(
    queueKey,
    (params.events ?? peekSystemEventEntries(queueKey)).filter(
      (event) => !isSystemEventTurnOwned(queueKey, event),
    ),
    { deferredEventIds: params.deferredEventIds },
  );
  const sessionStateNotices = queued.flatMap((event) => {
    const targetSessionKey = event.contextKey
      ? decodeSessionStateNoticeContextKey(event.contextKey)
      : undefined;
    return targetSessionKey === undefined
      ? []
      : [{ targetSessionKey, watcherStorePath: event.sessionStorePath ?? null }];
  });
  if (sessionStateNotices.length > 0) {
    await acknowledgeSessionStateNotices(params.sessionKey, sessionStateNotices);
  }
  for (const event of queued) {
    // A same-store resolver handoff does not retire already-consumed events.
    if (!isSystemEventStoreCurrent(params.sessionKey, event.sessionStorePath, params.agentId)) {
      continue;
    }
    const compacted = compactSystemEvent(event);
    if (!compacted) {
      continue;
    }
    const timestamp = `[${formatSystemEventTimestamp(event.ts, params.cfg)}]`;
    // Inbound text is deliberately not rewritten to neutralize look-alike `System:` lines.
    // Role separation plus external-content wrapping is the boundary.
    // This is an explicit product decision.
    for (const [index, subline] of compacted.split("\n").entries()) {
      systemLines.push(`System: ${index === 0 ? `${timestamp} ` : ""}${subline}`);
    }
  }
  // Each sub-line gets its own prefix so continuation lines can't be mistaken
  // for regular user content.
  const summaryLines =
    params.isMainSession && params.isNewSession
      ? (await buildChannelSummary(params.cfg)).flatMap((line) =>
          line.split("\n").map((subline) => `System: ${subline}`),
        )
      : [];
  return [...summaryLines, ...systemLines].join("\n") || undefined;
}
