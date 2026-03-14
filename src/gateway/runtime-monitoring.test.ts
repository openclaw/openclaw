import { describe, expect, it } from "vitest";
import { buildAgentActivitySummary } from "./runtime-monitoring.js";

describe("buildAgentActivitySummary", () => {
  it("rolls agents into active, quiet, and idle buckets", () => {
    const now = new Date("2026-03-14T12:00:00.000Z").getTime();
    const summary = buildAgentActivitySummary({
      defaultAgentId: "gateway",
      now: () => now,
      agents: [
        {
          agentId: "gateway",
          isDefault: true,
          heartbeat: { enabled: true, everyMs: 60_000 },
          sessions: { recent: [{ key: "a", updatedAt: now - 2 * 60_000, age: 2 * 60_000 }] },
        },
        {
          agentId: "risk",
          isDefault: false,
          heartbeat: { enabled: true, everyMs: 60_000 },
          sessions: { recent: [{ key: "b", updatedAt: now - 30 * 60_000, age: 30 * 60_000 }] },
        },
        {
          agentId: "news",
          isDefault: false,
          heartbeat: { enabled: false, everyMs: null },
          sessions: { recent: [] },
        },
      ],
    });

    expect(summary).toMatchObject({
      defaultAgentId: "gateway",
      total: 3,
      active: 1,
      quiet: 1,
      idle: 1,
      heartbeatEnabled: 2,
      heartbeatDisabled: 1,
    });
    expect(summary.entries.map((entry) => [entry.agentId, entry.status])).toEqual([
      ["gateway", "active"],
      ["risk", "quiet"],
      ["news", "idle"],
    ]);
  });
});
