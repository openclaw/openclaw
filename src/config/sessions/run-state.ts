import type { SessionEntry } from "./types.js";

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function applyKilledSessionEntryState(
  entry: SessionEntry,
  params: {
    nowMs?: number;
    markAbortedLastRun?: boolean;
  } = {},
): SessionEntry {
  const nowMs = isFiniteTimestamp(params.nowMs) ? params.nowMs : Date.now();
  const endedAt = Math.max(
    nowMs,
    isFiniteTimestamp(entry.startedAt) ? entry.startedAt : 0,
    isFiniteTimestamp(entry.updatedAt) ? entry.updatedAt : 0,
    isFiniteTimestamp(entry.endedAt) ? entry.endedAt : 0,
  );

  entry.status = "killed";
  entry.endedAt = endedAt;
  entry.updatedAt = endedAt;

  if (isFiniteTimestamp(entry.startedAt)) {
    entry.runtimeMs = Math.max(0, endedAt - entry.startedAt);
  }
  if (params.markAbortedLastRun !== false) {
    entry.abortedLastRun = true;
  }

  return entry;
}
