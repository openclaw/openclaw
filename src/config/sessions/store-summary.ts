import fs from "node:fs";

export type SessionStoreSummaryEntry = {
  lastChannel?: string;
  lastTo?: string;
  updatedAt?: number;
};

function isSummaryRecord(value: unknown): value is Record<string, SessionStoreSummaryEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Heartbeat recipient resolution only needs a shallow snapshot of the session
// store. A direct read avoids dragging in the full session maintenance/cache
// stack on cold imports.
export function loadSessionStoreSummary(
  storePath: string,
): Record<string, SessionStoreSummaryEntry> {
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!isSummaryRecord(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}
