/**
 * @module mode-detector
 * Deterministic TypeScript mode detection for the Aether Attention Architecture.
 *
 * Implements the 5-tier priority cascade with hysteresis. Zero LLM calls.
 * Pure function — all state is passed in; no module-level side effects.
 *
 * Priority cascade (highest → lowest, stops at first confident result):
 *   1. Explicit user command  — bypasses hysteresis
 *   2. Active calendar event  — subject to hysteresis
 *   3. Channel activity       — subject to hysteresis
 *   4. Time-of-day default    — subject to hysteresis
 *   5. Uncertain fallback
 */

import type { AttentionConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of a single mode detection pass. */
export interface ModeDetectionResult {
  /** The resolved mode name (e.g. "deep_work", "trading"). */
  mode: string;

  /**
   * Confidence in the detection result on a 0–1 scale.
   * ~0.95 for explicit commands; ~0.80 for calendar; ~0.50–0.75 for
   * channel activity; ~0.50 for time defaults; ~0.30 for uncertain.
   */
  confidence: number;

  /** Which cascade tier produced this result. */
  set_by: "explicit_command" | "calendar" | "channel_activity" | "time_default" | "uncertain";

  /**
   * True when a higher-confidence mode was detected but hysteresis rules
   * blocked the transition (insufficient dwell time or signal strength).
   * When true, `mode` reflects the *current* (unchanged) mode, not the
   * detected candidate.
   */
  hysteresis_blocked: boolean;
}

/** An incoming message from any channel, used for mode detection. */
export interface RecentMessage {
  /** Channel identifier (e.g. "trading-signals", "osce-practice"). */
  channel: string;
  /** Raw message content for keyword matching. */
  content: string;
  /** Timestamp of the message. */
  timestamp: Date;
}

/** A calendar event, used to infer mode from active events. */
export interface CalendarEvent {
  /** Event title (searched for mode-keyword matches). */
  title: string;
  startTime: Date;
  endTime: Date;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Messages older than this many minutes are ignored for explicit commands. */
const EXPLICIT_COMMAND_WINDOW_MINUTES = 10;

/** Messages older than this many hours are ignored for channel activity. */
const CHANNEL_ACTIVITY_WINDOW_HOURS = 2;

/** Minimum channel messages required to trigger an activity-based mode signal. */
const CHANNEL_ACTIVITY_MIN_MESSAGES = 3;

/**
 * Scan recent messages for explicit mode-switch phrases.
 * Only considers messages within EXPLICIT_COMMAND_WINDOW_MINUTES.
 * Returns on first match (order of iteration is chronological-newest-first
 * in practice since callers typically sort descending).
 */
function detectExplicitCommand(
  recentMessages: RecentMessage[],
  config: AttentionConfig,
  now: Date,
): { mode: string; confidence: number } | null {
  const cutoff = new Date(now.getTime() - EXPLICIT_COMMAND_WINDOW_MINUTES * 60_000);

  for (const msg of recentMessages) {
    if (msg.timestamp < cutoff) {
      continue;
    }
    const lower = msg.content.toLowerCase();
    for (const [mode, phrases] of Object.entries(config.explicit_command_keywords)) {
      for (const phrase of phrases) {
        if (lower.includes(phrase.toLowerCase())) {
          return { mode, confidence: 0.95 };
        }
      }
    }
  }
  return null;
}

/**
 * Detect mode from currently active calendar events.
 * Checks event title against calendar_keyword_map.
 * An event is "active" when now falls within [startTime, endTime].
 */
function detectCalendarMode(
  calendarEvents: CalendarEvent[],
  now: Date,
  config: AttentionConfig,
): { mode: string; confidence: number } | null {
  for (const event of calendarEvents) {
    if (event.startTime > now || event.endTime < now) {
      continue;
    }
    const title = event.title.toLowerCase();
    for (const [mode, keywords] of Object.entries(config.calendar_keyword_map)) {
      for (const kw of keywords) {
        if (title.includes(kw.toLowerCase())) {
          return { mode, confidence: 0.8 };
        }
      }
    }
  }
  return null;
}

/**
 * Build a reverse map: channel name → mode (first mode that amplifies it wins).
 * Constructed once per detectMode call; cost is negligible.
 */
function buildChannelModeMap(config: AttentionConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const [modeName, modeConfig] of Object.entries(config.modes)) {
    for (const ch of modeConfig.channels_amplified) {
      if (!map.has(ch)) {
        map.set(ch, modeName);
      }
    }
  }
  return map;
}

/**
 * Detect mode from channel activity in the last CHANNEL_ACTIVITY_WINDOW_HOURS.
 * Counts amplified-channel messages per mode; requires CHANNEL_ACTIVITY_MIN_MESSAGES
 * to suppress noise.
 * Confidence scales from 0.50 → 0.75 with message volume.
 */
function detectChannelActivity(
  recentMessages: RecentMessage[],
  config: AttentionConfig,
  now: Date,
): { mode: string; confidence: number } | null {
  const channelModeMap = buildChannelModeMap(config);
  const cutoff = new Date(now.getTime() - CHANNEL_ACTIVITY_WINDOW_HOURS * 60 * 60_000);
  const modeCounts = new Map<string, number>();

  for (const msg of recentMessages) {
    if (msg.timestamp < cutoff) {
      continue;
    }
    const mode = channelModeMap.get(msg.channel);
    if (mode) {
      modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1);
    }
  }

  if (modeCounts.size === 0) {
    return null;
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [mode, count] of modeCounts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      best = mode;
    }
  }

  if (!best || bestCount < CHANNEL_ACTIVITY_MIN_MESSAGES) {
    return null;
  }

  // Confidence scales 0.50 → 0.75 based on volume, capped at 0.75
  const confidence = Math.min(0.75, 0.5 + bestCount * 0.05);
  return { mode: best, confidence };
}

/**
 * Parse a "HH:MM-HH:MM" time-range string into fractional hours.
 * Returns null if the format is unrecognised.
 */
function parseTimeRange(range: string): { start: number; end: number } | null {
  const dashIdx = range.indexOf("-");
  if (dashIdx === -1) {
    return null;
  }
  const startStr = range.slice(0, dashIdx);
  const endStr = range.slice(dashIdx + 1);

  const parseH = (t: string): number => {
    const [h, m] = t.split(":").map(Number);
    return (h ?? 0) + (m ?? 0) / 60;
  };

  const start = parseH(startStr);
  const end = parseH(endStr);
  if (isNaN(start) || isNaN(end)) {
    return null;
  }
  return { start, end };
}

/**
 * Resolve the time-default mode for a given fractional hour.
 * Handles the midnight-crossing range "22:00-00:00" by treating
 * a parsed end of 0 as 24.
 *
 * @param currentHour - Integer or fractional hour in [0, 24).
 */
function detectTimeDefault(
  currentHour: number,
  config: AttentionConfig,
): { mode: string; confidence: number } | null {
  for (const [range, mode] of Object.entries(config.time_defaults)) {
    const parsed = parseTimeRange(range);
    if (!parsed) {
      continue;
    }
    const { start } = parsed;
    // "22:00-00:00" → end=0 → treat as 24 (crosses midnight)
    const end = parsed.end === 0 ? 24 : parsed.end;
    if (currentHour >= start && currentHour < end) {
      return { mode, confidence: 0.5 };
    }
  }
  return null;
}

/**
 * Evaluate whether hysteresis rules permit a transition from the
 * current mode to the proposed mode.
 *
 * Rules (ALL must be satisfied):
 *   1. Sufficient dwell time in current mode (>= min_dwell_minutes)
 *   2. Proposed mode's entry_threshold met by detection signal
 *   3. Detection signal exceeds current mode's exit_threshold
 *      (proxy: if we're strongly detecting another mode, we've left this one)
 *
 * @returns true if the transition is permitted.
 */
function hysteresisAllows(
  currentMode: string,
  modeEnteredAt: Date,
  proposedMode: string,
  proposedConfidence: number,
  config: AttentionConfig,
  now: Date,
): boolean {
  // No transition needed — already in the proposed mode
  if (currentMode === proposedMode) {
    return true;
  }

  const currentCfg = config.modes[currentMode];
  const proposedCfg = config.modes[proposedMode];
  // If either mode is unknown, allow the transition rather than blocking
  if (!currentCfg || !proposedCfg) {
    return true;
  }

  const minutesInMode = (now.getTime() - modeEnteredAt.getTime()) / 60_000;
  const { min_dwell_minutes, exit_threshold } = currentCfg.hysteresis;
  const { entry_threshold } = proposedCfg.hysteresis;

  if (minutesInMode < min_dwell_minutes) {
    return false;
  }
  if (proposedConfidence < entry_threshold) {
    return false;
  }
  if (proposedConfidence < exit_threshold) {
    return false;
  }

  return true;
}

/**
 * Apply a detected candidate mode against hysteresis rules.
 * Returns a ModeDetectionResult, preserving currentMode when blocked.
 */
function applyHysteresis(
  candidate: { mode: string; confidence: number },
  setBy: ModeDetectionResult["set_by"],
  currentMode: string,
  modeEnteredAt: Date,
  config: AttentionConfig,
  now: Date,
): ModeDetectionResult {
  const allowed = hysteresisAllows(
    currentMode,
    modeEnteredAt,
    candidate.mode,
    candidate.confidence,
    config,
    now,
  );

  if (allowed) {
    return {
      mode: candidate.mode,
      confidence: candidate.confidence,
      set_by: setBy,
      hysteresis_blocked: false,
    };
  }

  // Transition blocked: report the detection but keep the current mode
  return {
    mode: currentMode,
    confidence: candidate.confidence,
    set_by: setBy,
    hysteresis_blocked: candidate.mode !== currentMode,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the current operating mode using a 5-tier priority cascade.
 *
 * All logic is deterministic — no LLM calls, no external I/O.
 * The function is pure with respect to the arguments; callers are
 * responsible for loading config and state before invoking.
 *
 * Priority (highest → lowest, stops at first confident match):
 * 1. **Explicit user command** — keyword detected in recent messages;
 *    bypasses hysteresis entirely.
 * 2. **Calendar event** — active event title matches calendar_keyword_map;
 *    subject to hysteresis.
 * 3. **Channel activity** — recent message volume in mode-amplified channels
 *    (requires ≥3 messages in last 2h); subject to hysteresis.
 * 4. **Time default** — hour-of-day lookup in time_defaults;
 *    subject to hysteresis.
 * 5. **Uncertain fallback** — returns current mode with low confidence.
 *
 * @param currentMode - The currently active mode name.
 * @param modeEnteredAt - Timestamp when the current mode was entered.
 * @param recentMessages - All messages available for context analysis.
 * @param currentHour - Current hour (0–23 integer, or fractional).
 * @param calendarEvents - Calendar events to check for active mode hints.
 * @param config - The loaded AttentionConfig from attention-config.json.
 * @returns A ModeDetectionResult describing the resolved mode and provenance.
 */
export function detectMode(
  currentMode: string,
  modeEnteredAt: Date,
  recentMessages: RecentMessage[],
  currentHour: number,
  calendarEvents: CalendarEvent[],
  config: AttentionConfig,
): ModeDetectionResult {
  const now = new Date();

  // ── 1. Explicit command (bypasses hysteresis) ─────────────────────────────
  const explicit = detectExplicitCommand(recentMessages, config, now);
  if (explicit) {
    return {
      mode: explicit.mode,
      confidence: explicit.confidence,
      set_by: "explicit_command",
      hysteresis_blocked: false,
    };
  }

  // ── 2. Calendar ───────────────────────────────────────────────────────────
  const calendar = detectCalendarMode(calendarEvents, now, config);
  if (calendar) {
    return applyHysteresis(calendar, "calendar", currentMode, modeEnteredAt, config, now);
  }

  // ── 3. Channel activity ───────────────────────────────────────────────────
  const activity = detectChannelActivity(recentMessages, config, now);
  if (activity) {
    return applyHysteresis(activity, "channel_activity", currentMode, modeEnteredAt, config, now);
  }

  // ── 4. Time default ───────────────────────────────────────────────────────
  const timeDefault = detectTimeDefault(currentHour, config);
  if (timeDefault) {
    return applyHysteresis(timeDefault, "time_default", currentMode, modeEnteredAt, config, now);
  }

  // ── 5. Uncertain fallback ─────────────────────────────────────────────────
  return {
    mode: currentMode || "uncertain",
    confidence: 0.3,
    set_by: "uncertain",
    hysteresis_blocked: false,
  };
}
