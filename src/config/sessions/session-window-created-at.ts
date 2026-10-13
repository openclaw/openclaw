import type { SessionEntry } from "./types.js";

export function resolveSessionWindowCreatedAt(entry: SessionEntry, updatedAt: number): number {
  for (const candidate of [entry.sessionStartedAt, entry.startedAt, entry.updatedAt, updatedAt]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return updatedAt;
}
