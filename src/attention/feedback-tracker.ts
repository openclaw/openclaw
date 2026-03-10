/**
 * @module feedback-tracker
 * 6-type feedback state machine for the Aether Attention Architecture.
 *
 * Tracks what happened to each attention-winning item and maintains
 * per-item salience modifiers in the range [0.5, 1.5].
 *
 * KEY INVARIANT — dismissed_timing NEVER decrements salience:
 *   The user dismissed because the *timing* was wrong, not because the
 *   content was irrelevant. Penalising timing dismissals would systematically
 *   deweight important-but-inconvenient signals — the opposite of the goal.
 *   dismissed_timing actually slightly *increases* the modifier (+0.05).
 *   See attention-architecture-spec-v2.md §8.1 for the full argument.
 *
 * Storage: ~/aether/attention/feedback.jsonl (append-only, one JSON per line).
 * In-memory cache is loaded lazily on first read and kept warm.
 * The cache survives the process lifetime; for multi-process setups the
 * JSONL file is the authoritative source.
 *
 * All exported functions are synchronous (file I/O uses fs sync APIs).
 * Side-effect-free except for recordFeedback which appends to the log.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The six recognised feedback types.
 *
 * - dismissed_timing:  Dismissed because timing was wrong. NEVER negative.
 * - dismissed_context: Dismissed because content was irrelevant.
 * - acknowledged:      User saw it but didn't act.
 * - acted_on:          User took concrete action.
 * - deferred:          User explicitly deferred for later.
 * - expired:           Item timed out with no feedback.
 */
export type FeedbackType =
  | "dismissed_timing"
  | "dismissed_context"
  | "acknowledged"
  | "acted_on"
  | "deferred"
  | "expired";

/** A single feedback event written to the append-only log. */
export interface FeedbackEvent {
  /** SHA-256 or similar hash of the item content for stable identity. */
  item_hash: string;

  /** First 100 characters of item content for human readability in the log. */
  item_content_preview: string;

  /** The feedback classification. */
  feedback_type: FeedbackType;

  /** ISO 8601 timestamp of when the feedback was recorded. */
  timestamp: string;

  /** The operating mode that was active when feedback was given. */
  mode_at_feedback: string;
}

// ---------------------------------------------------------------------------
// State machine delta table
// ---------------------------------------------------------------------------

/**
 * Salience modifier deltas per feedback type.
 *
 * CRITICAL: dismissed_timing = +0.05 (never zero, never negative).
 * The item was relevant — the user just had bad timing. Slightly increase
 * the modifier to reflect the confirmed relevance.
 *
 * All deltas are applied to a per-item running modifier clamped to [0.5, 1.5].
 */
const FEEDBACK_DELTAS: Record<FeedbackType, number> = {
  dismissed_timing: +0.05, // NEVER negative — timing ≠ content irrelevance
  dismissed_context: -0.15, // Content was irrelevant — decrement
  acknowledged: +0.05, // Seen but not acted on — small positive
  acted_on: +0.15, // User took action — strong positive
  deferred: +0.02, // Explicitly deferred — neutral/small positive
  expired: -0.05, // Timed out — small negative
};

const MODIFIER_MIN = 0.5;
const MODIFIER_MAX = 1.5;
const DEFAULT_MODIFIER = 1.0;

// ---------------------------------------------------------------------------
// File path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the feedback log path, allowing override via environment variable
 * AETHER_FEEDBACK_PATH for testing.
 */
function resolveFeedbackPath(): string {
  return (
    process.env["AETHER_FEEDBACK_PATH"] ??
    path.join(os.homedir(), "aether", "attention", "feedback.jsonl")
  );
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

/** Per-item salience modifiers derived from feedback history. */
let modifierCache: Map<string, number> | null = null;

/**
 * Clamp a value to the [MODIFIER_MIN, MODIFIER_MAX] range.
 */
function clamp(value: number): number {
  return Math.max(MODIFIER_MIN, Math.min(MODIFIER_MAX, value));
}

/**
 * Apply a feedback delta to the cache for a given item hash.
 */
function applyDelta(cache: Map<string, number>, hash: string, feedbackType: FeedbackType): void {
  const current = cache.get(hash) ?? DEFAULT_MODIFIER;
  const delta = FEEDBACK_DELTAS[feedbackType];
  cache.set(hash, clamp(current + delta));
}

/**
 * Load the feedback JSONL file and build the in-memory cache.
 * Called lazily on first read. Swallows file-not-found errors silently.
 */
function loadCache(): Map<string, number> {
  const cache = new Map<string, number>();
  const filePath = resolveFeedbackPath();

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const event = JSON.parse(trimmed) as FeedbackEvent;
        if (event.item_hash && event.feedback_type) {
          applyDelta(cache, event.item_hash, event.feedback_type);
        }
      } catch {
        // Malformed line — skip silently
      }
    }
  } catch (err: unknown) {
    // File not found or unreadable — start with empty cache
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Log unexpected errors but don't throw — the tracker should never crash
      process.stderr.write(
        `[feedback-tracker] Warning: could not read ${filePath}: ${String(err)}\n`,
      );
    }
  }

  return cache;
}

/**
 * Return the initialised cache, loading from disk if necessary.
 */
function ensureCache(): Map<string, number> {
  if (modifierCache === null) {
    modifierCache = loadCache();
  }
  return modifierCache;
}

/**
 * Reset the in-memory cache. Used in tests to ensure a clean state.
 * @internal
 */
export function _resetCacheForTest(): void {
  modifierCache = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a feedback event and update the per-item salience modifier.
 *
 * Appends the event as a JSON line to ~/aether/attention/feedback.jsonl
 * and updates the in-memory cache immediately (no re-read required).
 * Creates the directory if it doesn't exist.
 *
 * @param event - The feedback event to record.
 * @throws If the file cannot be written (permissions error, disk full, etc.).
 */
export function recordFeedback(event: FeedbackEvent): void {
  // Load cache BEFORE appending to file — prevents double-counting.
  // If ensureCache() runs after appendFileSync it would parse the new
  // event from disk AND then we'd applyDelta a second time below.
  const cache = ensureCache();

  const filePath = resolveFeedbackPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // Append to JSONL log (append-only — never overwrite)
  fs.appendFileSync(filePath, JSON.stringify(event) + "\n", "utf-8");

  // Apply a single delta to the already-loaded cache
  applyDelta(cache, event.item_hash, event.feedback_type);
}

/**
 * Return the salience modifier for a given item hash.
 *
 * The modifier is a multiplicative factor in [0.5, 1.5] applied to the
 * base salience score. Items with no feedback history return 1.0 (neutral).
 *
 * @param item_hash - The hash identifying the item.
 * @returns Modifier in [0.5, 1.5]; defaults to 1.0 if the hash is unknown.
 */
export function getSalienceModifier(item_hash: string): number {
  return ensureCache().get(item_hash) ?? DEFAULT_MODIFIER;
}

/**
 * Return aggregate feedback statistics for all tracked items.
 *
 * Each entry contains the total event count for that feedback type and the
 * cumulative delta (net change) applied across all items.
 *
 * Useful for monitoring routing quality (e.g. high dismissed_context rate
 * signals over-routing; high expired rate signals suppression threshold
 * may be too aggressive).
 *
 * @returns Record keyed by FeedbackType with count and net_delta.
 */
export function getFeedbackStats(): Record<string, { count: number; net_delta: number }> {
  const filePath = resolveFeedbackPath();
  const stats: Record<string, { count: number; net_delta: number }> = {};

  // Initialise all known types to zero
  for (const type of Object.keys(FEEDBACK_DELTAS) as FeedbackType[]) {
    stats[type] = { count: 0, net_delta: 0 };
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const event = JSON.parse(trimmed) as FeedbackEvent;
        const type = event.feedback_type;
        if (!type || !(type in FEEDBACK_DELTAS)) {
          continue;
        }
        const entry = stats[type];
        if (entry) {
          entry.count += 1;
          entry.net_delta += FEEDBACK_DELTAS[type] ?? 0;
        }
      } catch {
        // Malformed line — skip
      }
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      process.stderr.write(
        `[feedback-tracker] Warning: could not read ${filePath}: ${String(err)}\n`,
      );
    }
  }

  return stats;
}
