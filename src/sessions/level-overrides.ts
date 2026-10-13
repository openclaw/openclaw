import {
  normalizeTraceLevel,
  normalizeVerboseLevel,
  type TraceLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions.js";

// Session-level override parsers use tri-state results: undefined means no
// change, null clears the saved override, and a level writes the override.
function parseLevelOverride<Level extends string>(
  raw: unknown,
  normalize: (value: string) => Level | undefined,
  error: string,
): { ok: true; value: Level | null | undefined } | { ok: false; error: string } {
  if (raw === null || raw === undefined) {
    return { ok: true, value: raw };
  }
  const normalized = typeof raw === "string" ? normalize(raw) : undefined;
  return normalized ? { ok: true, value: normalized } : { ok: false, error };
}

export function parseVerboseOverride(
  raw: unknown,
): { ok: true; value: VerboseLevel | null | undefined } | { ok: false; error: string } {
  return parseLevelOverride(
    raw,
    normalizeVerboseLevel,
    'invalid verboseLevel (use "on"|"off"|"full")',
  );
}

// Mutates a persisted session entry after parsing. Callers keep parse/apply
// separate so invalid user input can be reported before touching the store.
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

export function parseTraceOverride(
  raw: unknown,
): { ok: true; value: TraceLevel | null | undefined } | { ok: false; error: string } {
  return parseLevelOverride(raw, normalizeTraceLevel, 'invalid traceLevel (use "on"|"off"|"raw")');
}

// Mutates trace override with the same tri-state contract as verbose level.
export function applyTraceOverride(entry: SessionEntry, level: TraceLevel | null | undefined) {
  if (level === undefined) {
    return;
  }
  if (level === null) {
    delete entry.traceLevel;
    return;
  }
  entry.traceLevel = level;
}
