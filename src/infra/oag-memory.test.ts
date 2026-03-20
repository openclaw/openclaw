import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFiles = vi.hoisted(() => new Map<string, string>());
const mockReadFileDelay = vi.hoisted(() => vi.fn<() => number>(() => 0));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (p: string) => {
      const delay = mockReadFileDelay();
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
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
    copyFile: vi.fn(async (src: string, dest: string) => {
      const content = mockFiles.get(src);
      if (content !== undefined) {
        mockFiles.set(dest, content);
      }
    }),
  },
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/oag-test",
}));

vi.mock("./oag-config.js", () => ({
  resolveOagMemoryMaxLifecycleAgeDays: () => 30,
}));

vi.mock("./restart-sentinel.js", () => ({
  resolveRestartSentinelPath: () => "/tmp/oag-test/restart-sentinel.json",
}));

const {
  loadOagMemory,
  saveOagMemory,
  recordLifecycleShutdown,
  recordEvolution,
  recordDiagnosis,
  getRecentCrashes,
  findRecurringIncidentPattern,
  appendAuditEntry,
  appendMetricSnapshot,
  updateRecommendationOutcome,
  readSentinelContext,
} = await import("./oag-memory.js");

describe("oag-memory", () => {
  beforeEach(() => {
    mockFiles.clear();
    mockReadFileDelay.mockReset();
  });

  it("returns empty memory when file does not exist", async () => {
    const memory = await loadOagMemory();
    expect(memory.version).toBe(1);
    expect(memory.lifecycles).toEqual([]);
    expect(memory.evolutions).toEqual([]);
    expect(memory.diagnoses).toEqual([]);
    expect(memory.auditLog).toEqual([]);
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

  it("recovers from backup when main file is corrupted", async () => {
    // First save: creates main file (no backup yet)
    const memory = await loadOagMemory();
    memory.lifecycles.push({
      id: "backup-test",
      startedAt: new Date().toISOString(),
      stoppedAt: new Date().toISOString(),
      stopReason: "clean",
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [],
    });
    await saveOagMemory(memory);

    // Second save: copies current main file to .bak before overwriting
    await saveOagMemory(memory);

    // Corrupt main file
    const mainPath = "/tmp/oag-test/oag-memory.json";
    mockFiles.set(mainPath, "CORRUPTED{{{");

    // Load should recover from backup
    const recovered = await loadOagMemory();
    expect(recovered.lifecycles).toHaveLength(1);
    expect(recovered.lifecycles[0].id).toBe("backup-test");
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

  it("appends audit entries", async () => {
    await appendAuditEntry({
      timestamp: new Date().toISOString(),
      action: "evolution_applied",
      detail: "test evolution applied",
      changes: [{ configPath: "gateway.oag.delivery.maxRetries", from: 5, to: 7 }],
    });
    await appendAuditEntry({
      timestamp: new Date().toISOString(),
      action: "evolution_confirmed",
      detail: "test evolution confirmed",
    });
    const memory = await loadOagMemory();
    expect(memory.auditLog).toHaveLength(2);
    expect(memory.auditLog[0].action).toBe("evolution_applied");
    expect(memory.auditLog[1].action).toBe("evolution_confirmed");
  });

  it("caps audit log at 200 entries", async () => {
    // Pre-fill with 199 entries
    const memory = await loadOagMemory();
    for (let i = 0; i < 199; i++) {
      memory.auditLog.push({
        timestamp: new Date().toISOString(),
        action: "evolution_applied",
        detail: `entry-${i}`,
      });
    }
    await saveOagMemory(memory);

    // Append 2 more — should cap at 200
    await appendAuditEntry({
      timestamp: new Date().toISOString(),
      action: "evolution_confirmed",
      detail: "entry-199",
    });
    await appendAuditEntry({
      timestamp: new Date().toISOString(),
      action: "evolution_reverted",
      detail: "entry-200",
    });

    const final = await loadOagMemory();
    expect(final.auditLog).toHaveLength(200);
    // Oldest entry should have been trimmed (entry-0 gone)
    expect(final.auditLog[0].detail).toBe("entry-1");
    expect(final.auditLog[199].detail).toBe("entry-200");
  });

  it("ensures auditLog on legacy memory files missing the field", async () => {
    // Simulate a legacy memory file without auditLog
    const mainPath = "/tmp/oag-test/oag-memory.json";
    const legacy = {
      version: 1,
      lifecycles: [],
      evolutions: [],
      diagnoses: [],
    };
    mockFiles.set(mainPath, JSON.stringify(legacy));

    const memory = await loadOagMemory();
    expect(memory.auditLog).toEqual([]);
  });

  it("ensures metricSeries on legacy memory files missing the field", async () => {
    const mainPath = "/tmp/oag-test/oag-memory.json";
    const legacy = {
      version: 1,
      lifecycles: [],
      evolutions: [],
      diagnoses: [],
    };
    mockFiles.set(mainPath, JSON.stringify(legacy));

    const memory = await loadOagMemory();
    expect(memory.metricSeries).toEqual([]);
  });

  it("appends metric snapshots", async () => {
    await appendMetricSnapshot({
      timestamp: new Date().toISOString(),
      uptimeMs: 3600000,
      metrics: { channelRestarts: 5, noteDeliveries: 10 },
    });
    await appendMetricSnapshot({
      timestamp: new Date().toISOString(),
      uptimeMs: 7200000,
      metrics: { channelRestarts: 8, noteDeliveries: 15 },
    });
    const memory = await loadOagMemory();
    expect(memory.metricSeries).toHaveLength(2);
    expect(memory.metricSeries[0].metrics.channelRestarts).toBe(5);
    expect(memory.metricSeries[1].metrics.channelRestarts).toBe(8);
  });

  it("caps metricSeries at 168 entries", async () => {
    // Pre-fill with 167 entries
    const memory = await loadOagMemory();
    for (let i = 0; i < 167; i++) {
      memory.metricSeries.push({
        timestamp: new Date(Date.now() - (167 - i) * 3600000).toISOString(),
        uptimeMs: i * 3600000,
        metrics: { channelRestarts: i },
      });
    }
    await saveOagMemory(memory);

    // Append 2 more — should cap at 168
    await appendMetricSnapshot({
      timestamp: new Date().toISOString(),
      uptimeMs: 167 * 3600000,
      metrics: { channelRestarts: 167 },
    });
    await appendMetricSnapshot({
      timestamp: new Date().toISOString(),
      uptimeMs: 168 * 3600000,
      metrics: { channelRestarts: 168 },
    });

    const final = await loadOagMemory();
    expect(final.metricSeries).toHaveLength(168);
    // Oldest entry (index 0, channelRestarts: 0) should be trimmed
    expect(final.metricSeries[0].metrics.channelRestarts).toBe(1);
    expect(final.metricSeries[167].metrics.channelRestarts).toBe(168);
  });

  describe("updateRecommendationOutcome", () => {
    it("updates outcome for a recommendation in recommendations array", async () => {
      await recordDiagnosis({
        id: "diag-outcome-1",
        triggeredAt: new Date().toISOString(),
        trigger: "recurring_pattern",
        rootCause: "Rate limit",
        confidence: 0.9,
        recommendations: [
          {
            type: "config_change",
            description: "Increase budget",
            configPath: "gateway.oag.delivery.recoveryBudgetMs",
            suggestedValue: 90000,
            risk: "low",
            applied: true,
            recommendationId: "diag-outcome-1-rec-0",
            outcome: "pending",
          },
        ],
        completedAt: new Date().toISOString(),
      });

      const updated = await updateRecommendationOutcome(
        "diag-outcome-1",
        "diag-outcome-1-rec-0",
        "effective",
      );
      expect(updated).toBe(true);

      const memory = await loadOagMemory();
      const diag = memory.diagnoses.find((d) => d.id === "diag-outcome-1");
      expect(diag).toBeDefined();
      expect(diag!.recommendations[0].outcome).toBe("effective");
      expect(diag!.recommendations[0].outcomeAt).toBeDefined();
    });

    it("updates outcome for a tracked recommendation", async () => {
      await recordDiagnosis({
        id: "diag-outcome-2",
        triggeredAt: new Date().toISOString(),
        trigger: "recurring_pattern",
        rootCause: "Timeout",
        confidence: 0.8,
        recommendations: [],
        trackedRecommendations: [
          {
            id: "diag-outcome-2-rec-0",
            parameter: "gateway.oag.delivery.maxRetries",
            oldValue: 5,
            newValue: 7,
            risk: "low",
            applied: true,
            outcome: "pending",
          },
        ],
        completedAt: new Date().toISOString(),
      });

      const updated = await updateRecommendationOutcome(
        "diag-outcome-2",
        "diag-outcome-2-rec-0",
        "reverted",
      );
      expect(updated).toBe(true);

      const memory = await loadOagMemory();
      const diag = memory.diagnoses.find((d) => d.id === "diag-outcome-2");
      expect(diag!.trackedRecommendations![0].outcome).toBe("reverted");
      expect(diag!.trackedRecommendations![0].outcomeAt).toBeDefined();
    });

    it("returns false when diagnosis not found", async () => {
      const updated = await updateRecommendationOutcome("nonexistent", "rec-0", "effective");
      expect(updated).toBe(false);
    });

    it("returns false when recommendation id not found in diagnosis", async () => {
      await recordDiagnosis({
        id: "diag-outcome-3",
        triggeredAt: new Date().toISOString(),
        trigger: "recurring_pattern",
        rootCause: "test",
        confidence: 0.5,
        recommendations: [
          {
            type: "config_change",
            description: "test",
            risk: "low",
            applied: false,
            recommendationId: "diag-outcome-3-rec-0",
          },
        ],
        completedAt: new Date().toISOString(),
      });

      const updated = await updateRecommendationOutcome(
        "diag-outcome-3",
        "nonexistent-rec",
        "effective",
      );
      expect(updated).toBe(false);
    });
  });

  describe("readSentinelContext", () => {
    it("returns context from a valid sentinel file", async () => {
      const sentinel = {
        version: 1,
        payload: {
          kind: "restart",
          status: "ok",
          ts: 1710700000000,
          sessionKey: "session-abc",
          deliveryContext: {
            channel: "telegram",
            to: "12345",
          },
        },
      };
      mockFiles.set("/tmp/oag-test/restart-sentinel.json", JSON.stringify(sentinel));
      const ctx = await readSentinelContext();
      expect(ctx).toBeDefined();
      expect(ctx!.sessionKey).toBe("session-abc");
      expect(ctx!.channel).toBe("telegram");
      expect(ctx!.stopReason).toBe("restart");
      expect(ctx!.timestamp).toBeDefined();
    });

    it("returns undefined when sentinel file does not exist", async () => {
      const ctx = await readSentinelContext();
      expect(ctx).toBeUndefined();
    });

    it("returns undefined for corrupted sentinel file", async () => {
      mockFiles.set("/tmp/oag-test/restart-sentinel.json", "NOT VALID JSON{{{");
      const ctx = await readSentinelContext();
      expect(ctx).toBeUndefined();
    });

    it("returns undefined when sentinel has wrong version", async () => {
      const sentinel = {
        version: 99,
        payload: {
          kind: "restart",
          ts: 1710700000000,
        },
      };
      mockFiles.set("/tmp/oag-test/restart-sentinel.json", JSON.stringify(sentinel));
      const ctx = await readSentinelContext();
      expect(ctx).toBeUndefined();
    });

    it("returns undefined when payload has no extractable fields", async () => {
      const sentinel = {
        version: 1,
        payload: {
          status: "ok",
          message: "just a message",
        },
      };
      mockFiles.set("/tmp/oag-test/restart-sentinel.json", JSON.stringify(sentinel));
      const ctx = await readSentinelContext();
      expect(ctx).toBeUndefined();
    });
  });

  it("records lifecycle shutdown with sentinel context", async () => {
    await recordLifecycleShutdown({
      startedAt: Date.now() - 60000,
      stopReason: "crash",
      metricsSnapshot: { channelRestarts: 1 },
      incidents: [],
      sentinelContext: {
        sessionKey: "sess-123",
        channel: "telegram",
        stopReason: "restart",
        timestamp: "2026-03-17T00:00:00.000Z",
      },
    });
    const memory = await loadOagMemory();
    expect(memory.lifecycles).toHaveLength(1);
    expect(memory.lifecycles[0].sentinelContext).toBeDefined();
    expect(memory.lifecycles[0].sentinelContext!.sessionKey).toBe("sess-123");
    expect(memory.lifecycles[0].sentinelContext!.channel).toBe("telegram");
  });

  it("omits sentinelContext when not provided", async () => {
    await recordLifecycleShutdown({
      startedAt: Date.now() - 60000,
      stopReason: "clean",
      metricsSnapshot: {},
      incidents: [],
    });
    const memory = await loadOagMemory();
    expect(memory.lifecycles).toHaveLength(1);
    expect(memory.lifecycles[0].sentinelContext).toBeUndefined();
  });

  it("returns empty memory when main file is missing and backup read times out", async () => {
    const mainPath = "/tmp/oag-test/oag-memory.json";
    const backupPath = `${mainPath}.bak`;

    // Only set up backup file (main file missing)
    const validMemory = {
      version: 1,
      lifecycles: [],
      evolutions: [],
      diagnoses: [],
      auditLog: [],
      metricSeries: [],
    };
    mockFiles.set(backupPath, JSON.stringify(validMemory));

    // Main file read throws ENOENT immediately (no delay needed)
    // Backup file read times out (10s delay > 5s timeout)
    mockReadFileDelay.mockReturnValueOnce(0).mockReturnValueOnce(10000);

    const memory = await loadOagMemory();
    // Should return empty memory after backup timeout
    expect(memory.version).toBe(1);
    expect(memory.lifecycles).toEqual([]);
  });

  it("returns empty memory when both main and backup reads time out", async () => {
    const mainPath = "/tmp/oag-test/oag-memory.json";
    const backupPath = `${mainPath}.bak`;

    // Set up valid files (they exist but reads will time out)
    const validMemory = {
      version: 1,
      lifecycles: [],
      evolutions: [],
      diagnoses: [],
      auditLog: [],
      metricSeries: [],
    };
    mockFiles.set(mainPath, JSON.stringify(validMemory));
    mockFiles.set(backupPath, JSON.stringify(validMemory));

    // Both reads time out (10s delay > 5s timeout)
    mockReadFileDelay.mockReturnValueOnce(10000).mockReturnValueOnce(10000);

    const memory = await loadOagMemory();
    // Should return empty memory after both timeouts
    expect(memory.version).toBe(1);
    expect(memory.lifecycles).toEqual([]);
  });

  it("returns empty memory on main file read timeout", async () => {
    const mainPath = "/tmp/oag-test/oag-memory.json";
    const backupPath = `${mainPath}.bak`;

    // Set up valid files
    const validMemory = {
      version: 1,
      lifecycles: [],
      evolutions: [],
      diagnoses: [],
      auditLog: [],
      metricSeries: [],
    };
    mockFiles.set(mainPath, JSON.stringify(validMemory));
    mockFiles.set(backupPath, JSON.stringify(validMemory));

    // Simulate a slow read that exceeds the 5s timeout
    mockReadFileDelay.mockReturnValueOnce(10000);

    const memory = await loadOagMemory();
    // Should fall through to empty memory after timeout
    expect(memory.version).toBe(1);
    expect(memory.lifecycles).toEqual([]);
  });
});
