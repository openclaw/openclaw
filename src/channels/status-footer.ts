/**
 * Deterministic status line for the bottom of an in-flight progress draft.
 *
 * Pure template only: the progress-draft compositor owns when this renders and the
 * channel draft teardown owns removal, so there is deliberately no per-conversation
 * state, message tracking, or strip/relocation bookkeeping here.
 */
import type { StatusFooterMode } from "../config/types.base.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";

const MAX_ACTIVITY_CHARS = 60;

function normalizeActivity(line: string): string {
  const normalized = line.replace(/\s+/g, " ").trim();
  // Truncate on code points, not UTF-16 units: a hard cut inside a surrogate
  // pair renders as replacement garbage and some transports reject it.
  const points = Array.from(normalized);
  if (points.length <= MAX_ACTIVITY_CHARS) {
    return normalized;
  }
  const contentLimit = MAX_ACTIVITY_CHARS - 1;
  const candidate = points.slice(0, contentLimit + 1).join("");
  const wordBoundary = candidate.lastIndexOf(" ");
  const base =
    wordBoundary >= Math.floor(candidate.length * 0.6)
      ? candidate.slice(0, wordBoundary)
      : points.slice(0, contentLimit).join("");
  return `${base.trimEnd()}…`;
}

/**
 * Renders `▸ <label> · <elapsed> · reply to steer`. Callers pass raw text; escaping
 * belongs to the channel renderer that ultimately emits the line.
 */
export function renderStatusFooterLine(params: {
  mode: Exclude<StatusFooterMode, "off">;
  activityLabel?: string;
  elapsedMs: number;
}): string {
  const activity = params.mode === "activity" ? normalizeActivity(params.activityLabel ?? "") : "";
  const label = activity || "Working";
  const elapsed = formatDurationCompact(Math.max(0, params.elapsedMs)) ?? "0s";
  return `▸ ${label} · ${elapsed} · reply to steer`;
}
