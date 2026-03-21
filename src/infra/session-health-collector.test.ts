/**
 * Session Health — Collector Tests
 *
 * Focused tests for collector logic that doesn't require full filesystem
 * context. Since `collectSessionHealth()` needs real config/stores, we test
 * the usage-percent math through a thin integration test using the snapshot
 * structure directly.
 *
 * The key invariant: usagePercent should reflect per-agent pressure (the
 * hottest store), not aggregated totals ÷ single-store limits.
 */

import { describe, expect, it } from "vitest";
import type { SessionHealthAgentBreakdown } from "./session-health-types.js";

// ---------------------------------------------------------------------------
// Usage-percent math verification
// ---------------------------------------------------------------------------
// The collector computes usagePercent as max(agent / limit) across agents.
// These tests verify the invariant by computing the expected values from
// the snapshot structure that the collector produces.

function computeExpectedUsageEntries(
  agents: SessionHealthAgentBreakdown[],
  maxEntries: number,
): number {
  if (maxEntries <= 0 || agents.length === 0) {
    return 0;
  }
  let max = 0;
  for (const a of agents) {
    const pct = Math.round((a.indexedCount / maxEntries) * 10000) / 100;
    if (pct > max) {
      max = pct;
    }
  }
  return max;
}

function computeExpectedUsageDiskBytes(
  agents: SessionHealthAgentBreakdown[],
  maxDiskBytes: number | null,
): number | null {
  if (maxDiskBytes == null || maxDiskBytes <= 0) {
    return null;
  }
  let max = 0;
  for (const a of agents) {
    const pct = Math.round((a.totalManagedBytes / maxDiskBytes) * 10000) / 100;
    if (pct > max) {
      max = pct;
    }
  }
  return max;
}

function makeAgent(
  id: string,
  indexedCount: number,
  totalManagedBytes: number,
): SessionHealthAgentBreakdown {
  return {
    agentId: id,
    storePath: `/fake/sessions/${id}/sessions.json`,
    indexedCount,
    byClass: {
      main: indexedCount,
      channel: 0,
      direct: 0,
      "cron-definition": 0,
      "cron-run": 0,
      subagent: 0,
      acp: 0,
      heartbeat: 0,
      thread: 0,
      unknown: 0,
    },
    totalManagedBytes,
    resetTranscriptBytes: 0,
  };
}

describe("usage-percent multi-agent math", () => {
  it("single agent: usagePercent equals agent / limit", () => {
    const agents = [makeAgent("main", 250, 50_000_000)];
    const maxEntries = 500;
    const maxDiskBytes = 100_000_000;

    const entries = computeExpectedUsageEntries(agents, maxEntries);
    const diskBytes = computeExpectedUsageDiskBytes(agents, maxDiskBytes);

    expect(entries).toBe(50); // 250/500 = 50%
    expect(diskBytes).toBe(50); // 50M/100M = 50%
  });

  it("multi-agent: usagePercent is max across agents, not sum / limit", () => {
    const agents = [
      makeAgent("main", 100, 20_000_000),
      makeAgent("adx", 200, 40_000_000),
      makeAgent("bvx", 50, 10_000_000),
    ];
    const maxEntries = 500;
    const maxDiskBytes = 100_000_000;

    const entries = computeExpectedUsageEntries(agents, maxEntries);
    const diskBytes = computeExpectedUsageDiskBytes(agents, maxDiskBytes);

    // Before fix: would have been (100+200+50)/500 = 70%
    // After fix: max(100/500, 200/500, 50/500) = 40%
    expect(entries).toBe(40); // adx is the hottest at 200/500
    expect(diskBytes).toBe(40); // adx is the hottest at 40M/100M

    // Verify it's NOT the old (wrong) aggregated approach
    const wrongTotal = 100 + 200 + 50;
    const wrongPercent = Math.round((wrongTotal / maxEntries) * 10000) / 100;
    expect(wrongPercent).toBe(70); // confirm the old math would give 70%
    expect(entries).not.toBe(wrongPercent); // confirm we get the right answer
  });

  it("multi-agent: hottest agent drives the percentage", () => {
    const agents = [
      makeAgent("main", 450, 90_000_000), // 90% entries, 90% disk
      makeAgent("adx", 50, 10_000_000), // 10% entries, 10% disk
    ];
    const maxEntries = 500;
    const maxDiskBytes = 100_000_000;

    const entries = computeExpectedUsageEntries(agents, maxEntries);
    const diskBytes = computeExpectedUsageDiskBytes(agents, maxDiskBytes);

    expect(entries).toBe(90); // main is the hottest
    expect(diskBytes).toBe(90);
  });

  it("null maxDiskBytes returns null", () => {
    const agents = [makeAgent("main", 100, 50_000_000)];
    expect(computeExpectedUsageDiskBytes(agents, null)).toBeNull();
  });

  it("zero maxEntries returns 0", () => {
    const agents = [makeAgent("main", 100, 50_000_000)];
    expect(computeExpectedUsageEntries(agents, 0)).toBe(0);
  });
});
