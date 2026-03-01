export type EventLogEntry = {
  ts: number;
  event: string;
  payload?: unknown;
};

export const EVENT_LOG_LIMIT = 250;

export function collapseHealthEventHistory(entries: EventLogEntry[]): EventLogEntry[] {
  let keptHealth = false;
  const next: EventLogEntry[] = [];
  for (const entry of entries) {
    if (entry.event !== "health") {
      next.push(entry);
      continue;
    }
    if (keptHealth) {
      continue;
    }
    keptHealth = true;
    next.push(entry);
  }
  return next;
}

export function appendEventLogEntry(
  entries: EventLogEntry[],
  entry: EventLogEntry,
  options?: { collapseHealthHistory?: boolean },
): EventLogEntry[] {
  const collapseHealthHistory = options?.collapseHealthHistory ?? false;
  const base =
    collapseHealthHistory && entry.event === "health"
      ? entries.filter((item) => item.event !== "health")
      : entries;
  const next = [entry, ...base].slice(0, EVENT_LOG_LIMIT);
  return collapseHealthHistory ? collapseHealthEventHistory(next) : next;
}
