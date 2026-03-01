import { describe, expect, it } from "vitest";
import {
  EVENT_LOG_LIMIT,
  appendEventLogEntry,
  collapseHealthEventHistory,
  type EventLogEntry,
} from "./app-events.ts";

function entry(event: string, ts: number): EventLogEntry {
  return { event, ts, payload: { ts } };
}

describe("app-events", () => {
  it("caps event log entries at the fixed ring-buffer limit", () => {
    let log: EventLogEntry[] = [];
    for (let i = 0; i < EVENT_LOG_LIMIT + 10; i += 1) {
      log = appendEventLogEntry(log, entry(`evt-${i}`, i));
    }
    expect(log).toHaveLength(EVENT_LOG_LIMIT);
    expect(log[0]?.event).toBe("evt-259");
    expect(log.at(-1)?.event).toBe("evt-10");
  });

  it("keeps health history when compaction is disabled", () => {
    let log: EventLogEntry[] = [];
    log = appendEventLogEntry(log, entry("health", 1), { collapseHealthHistory: false });
    log = appendEventLogEntry(log, entry("health", 2), { collapseHealthHistory: false });
    expect(log.filter((item) => item.event === "health")).toHaveLength(2);
    expect(log[0]?.ts).toBe(2);
    expect(log[1]?.ts).toBe(1);
  });

  it("keeps only the latest health event when compaction is enabled", () => {
    let log: EventLogEntry[] = [entry("health", 1), entry("chat", 0), entry("health", -1)];
    log = appendEventLogEntry(log, entry("health", 2), { collapseHealthHistory: true });
    const healthEntries = log.filter((item) => item.event === "health");
    expect(healthEntries).toHaveLength(1);
    expect(healthEntries[0]?.ts).toBe(2);
    expect(log.map((item) => item.event)).toEqual(["health", "chat"]);
  });

  it("collapses existing health history while preserving newest-first order", () => {
    const log = collapseHealthEventHistory([
      entry("chat", 4),
      entry("health", 3),
      entry("presence", 2),
      entry("health", 1),
      entry("agent", 0),
    ]);
    expect(log.map((item) => `${item.event}:${item.ts}`)).toEqual([
      "chat:4",
      "health:3",
      "presence:2",
      "agent:0",
    ]);
  });
});
