import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFiles = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (p: string) => {
      if (!mockFiles.has(p)) {
        throw new Error("ENOENT");
      }
      return mockFiles.get(p) ?? "";
    }),
    writeFile: vi.fn(async (p: string, content: string) => {
      mockFiles.set(p, content);
    }),
    rename: vi.fn(async (src: string, dest: string) => {
      const content = mockFiles.get(src);
      if (content !== undefined) {
        mockFiles.set(dest, content);
        mockFiles.delete(src);
      }
    }),
    mkdir: vi.fn(async () => {}),
  },
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/oag-test",
}));

const {
  loadOagMemory,
  saveOagMemory,
  recordLifecycleShutdown,
  recordEvolution,
  recordDiagnosis,
  getRecentCrashes,
  findRecurringIncidentPattern,
} = await import("./oag-memory.js");

describe("oag-memory", () => {
  beforeEach(() => {
    mockFiles.clear();
  });

  it("returns empty memory when file does not exist", async () => {
    const memory = await loadOagMemory();
    expect(memory.version).toBe(1);
    expect(memory.lifecycles).toEqual([]);
    expect(memory.evolutions).toEqual([]);
    expect(memory.diagnoses).toEqual([]);
  });

  it("round-trips memory through save and load", async () => {
    const memory = await loadOagMemory();
    memory.lifecycles.push({
      id: "gw-test",
      startedAt: "2026-03-17T00:00:00Z",
      stoppedAt: "2026-03-17T01:00:00Z",
      stopReason: "crash",
      uptimeMs: 3600000,
      metricsSnapshot: { channelRestarts: 3 },
      incidents: [],
    });
    await saveOagMemory(memory);
    const loaded = await loadOagMemory();
    expect(loaded.lifecycles).toHaveLength(1);
    expect(loaded.lifecycles[0].id).toBe("gw-test");
  });

  it("records lifecycle shutdown", async () => {
    await recordLifecycleShutdown({
      startedAt: Date.now() - 60000,
      stopReason: "crash",
      metricsSnapshot: { channelRestarts: 2 },
      incidents: [
        {
          type: "channel_crash_loop",
          detail: "test",
          count: 1,
          firstAt: new Date().toISOString(),
          lastAt: new Date().toISOString(),
        },
      ],
    });
    const memory = await loadOagMemory();
    expect(memory.lifecycles).toHaveLength(1);
    expect(memory.lifecycles[0].stopReason).toBe("crash");
    expect(memory.lifecycles[0].incidents).toHaveLength(1);
  });

  it("finds recent crashes within window", async () => {
    const memory = await loadOagMemory();
    memory.lifecycles.push(
      {
        id: "old",
        startedAt: "2026-01-01T00:00:00Z",
        stoppedAt: "2026-01-01T01:00:00Z",
        stopReason: "crash",
        uptimeMs: 3600000,
        metricsSnapshot: {},
        incidents: [],
      },
      {
        id: "recent",
        startedAt: "2026-03-17T00:00:00Z",
        stoppedAt: new Date().toISOString(),
        stopReason: "crash",
        uptimeMs: 3600000,
        metricsSnapshot: {},
        incidents: [],
      },
      {
        id: "clean",
        startedAt: "2026-03-17T00:00:00Z",
        stoppedAt: new Date().toISOString(),
        stopReason: "clean",
        uptimeMs: 3600000,
        metricsSnapshot: {},
        incidents: [],
      },
    );
    const crashes = getRecentCrashes(memory, 24);
    expect(crashes).toHaveLength(1);
    expect(crashes[0].id).toBe("recent");
  });

  it("finds recurring incident patterns", async () => {
    const memory = await loadOagMemory();
    const now = new Date().toISOString();
    for (let i = 0; i < 4; i++) {
      memory.lifecycles.push({
        id: `lc-${i}`,
        startedAt: now,
        stoppedAt: now,
        stopReason: "crash",
        uptimeMs: 1000,
        metricsSnapshot: {},
        incidents: [
          {
            type: "channel_crash_loop",
            channel: "telegram",
            detail: "test",
            count: 1,
            firstAt: now,
            lastAt: now,
          },
        ],
      });
    }
    const patterns = findRecurringIncidentPattern(memory, 24, 3);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].type).toBe("channel_crash_loop");
    expect(patterns[0].channel).toBe("telegram");
    expect(patterns[0].occurrences).toBe(4);
  });

  it("records evolution and diagnosis", async () => {
    await recordEvolution({
      appliedAt: new Date().toISOString(),
      source: "adaptive",
      trigger: "high stale-poll rate",
      changes: [{ configPath: "gateway.oag.health.stalePollFactor", from: 2, to: 3 }],
    });
    await recordDiagnosis({
      id: "diag-1",
      triggeredAt: new Date().toISOString(),
      trigger: "recurring_crash",
      rootCause: "Telegram rate limit",
      confidence: 0.85,
      recommendations: [],
      completedAt: new Date().toISOString(),
    });
    const memory = await loadOagMemory();
    expect(memory.evolutions).toHaveLength(1);
    expect(memory.diagnoses).toHaveLength(1);
  });
});
