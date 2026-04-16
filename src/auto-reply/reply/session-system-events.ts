import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelSummary } from "../../infra/channel-summary.js";
import {
  formatUtcTimestamp,
  formatZonedTimestamp,
  resolveTimezone,
} from "../../infra/format-time/format-datetime.ts";
import { drainSystemEventEntries } from "../../infra/system-events.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

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

  const systemLines: string[] = [];
  const queued = drainSystemEventEntries(params.sessionKey);
  systemLines.push(
    ...queued.flatMap((event) => {
      const compacted = compactSystemEvent(event.text);
      if (!compacted) {
        return [];
      }
      // Prefer the explicit messageClass when present (Phase 1 Discord Surface
      // Overhaul). User-facing classes render as trusted; internal_narration
      // renders as untrusted. Fall back to the legacy `trusted` boolean for
      // older writers (now defaults to false at enqueue time).
      const classifiedTrusted =
        event.messageClass !== undefined
          ? event.messageClass !== "internal_narration"
          : event.trusted === true;
      const prefix = classifiedTrusted ? "System" : "System (untrusted)";
      const timestamp = `[${formatSystemEventTimestamp(event.ts, params.cfg)}]`;
      return compacted
        .split("\n")
        .map((subline, index) => `${prefix}: ${index === 0 ? `${timestamp} ` : ""}${subline}`);
    }),
  );
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
