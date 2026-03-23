import {
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions.js";

export function parseVerboseOverride(
  raw: unknown,
): { ok: true; value: VerboseLevel | null | undefined } | { ok: false; error: string } {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: 'invalid verboseLevel (use "on"|"off")' };
  }
  const normalized = normalizeVerboseLevel(raw);
  if (!normalized) {
    return { ok: false, error: 'invalid verboseLevel (use "on"|"off")' };
  }
  return { ok: true, value: normalized };
}

export function applyVerboseOverride(entry: SessionEntry, level: VerboseLevel | null | undefined) {
  if (level === undefined) {
    return;
  }
  if (level === null) {
    delete entry.verboseLevel;
    return;
  }
  entry.verboseLevel = level;
}

export function applyFutureThreadThinkingLevelOverride(
  entry: SessionEntry,
  level: ThinkLevel | null | undefined,
): { updated: boolean } {
  if (level === undefined) {
    return { updated: false };
  }

  if (level === null) {
    if (entry.futureThreadThinkingLevelOverride !== undefined) {
      delete entry.futureThreadThinkingLevelOverride;
      entry.updatedAt = Date.now();
      return { updated: true };
    }
    return { updated: false };
  }

  if (entry.futureThreadThinkingLevelOverride !== level) {
    entry.futureThreadThinkingLevelOverride = level;
    entry.updatedAt = Date.now();
    return { updated: true };
  }

  return { updated: false };
}
