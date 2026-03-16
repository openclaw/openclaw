import { describe, expect, it, vi, beforeEach } from "vitest";

// Use vi.hoisted so memoryFiles is available inside vi.mock factory (which is hoisted)
const memoryFiles = vi.hoisted(() => new Map<string, string>());

// currentConfig is mutable so loadConfig always returns the latest value and
// writeConfigFile can update it — allowing the full write-back chain to work.
const configState = vi.hoisted(() => ({
  current: {
    gateway: {
      oag: { delivery: { recoveryBudgetMs: 60000 } },
    },
  } as Record<string, unknown>,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => JSON.parse(JSON.stringify(configState.current)),
  writeConfigFile: vi.fn(async (cfg: unknown) => {
    configState.current = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  }),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/oag-integration-test",
}));

// Real in-memory file system so oag-memory, oag-config-writer, oag-evolution-guard,
// and oag-evolution-notify all share the same in-process state without touching disk.
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (p: string) => {
      if (!memoryFiles.has(p)) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return memoryFiles.get(p) ?? "";
    }),
    writeFile: vi.fn(async (p: string, content: string) => {
      memoryFiles.set(p, content);
    }),
    rename: vi.fn(async (src: string, dest: string) => {
      const content = memoryFiles.get(src);
      if (content !== undefined) {
        memoryFiles.set(dest, content);
        memoryFiles.delete(src);
      }
    }),
    mkdir: vi.fn(async () => {}),
    open: vi.fn(async () => ({
      writeFile: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    })),
    unlink: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ mtimeMs: Date.now() })),
    rm: vi.fn(async () => {}),
  },
}));

// Import after mocks
const { loadOagMemory, recordLifecycleShutdown } = await import("./oag-memory.js");
const { runPostRecoveryAnalysis } = await import("./oag-postmortem.js");
const { resetOagMetrics } = await import("./oag-metrics.js");

describe("OAG evolution integration", () => {
  beforeEach(() => {
    memoryFiles.clear();
    resetOagMetrics();
    // Reset config to initial state
    configState.current = {
      gateway: {
        oag: { delivery: { recoveryBudgetMs: 60000 } },
      },
    };
  });

  it("full chain: crashes → postmortem → recommendation → config write", async () => {
    // Step 1: Simulate 4 crash lifecycles with channel_crash_loop incidents
    const now = new Date().toISOString();
    for (let i = 0; i < 4; i++) {
      await recordLifecycleShutdown({
        startedAt: Date.now() - 60000,
        stopReason: "crash",
        metricsSnapshot: { channelRestarts: 3 },
        incidents: [
          {
            type: "channel_crash_loop",
            channel: "telegram",
            detail: "ETIMEDOUT",
            count: 1,
            firstAt: now,
            lastAt: now,
          },
        ],
      });
    }

    // Verify memory has 4 lifecycles
    const memory = await loadOagMemory();
    expect(memory.lifecycles).toHaveLength(4);

    // Step 2: Run postmortem
    const result = await runPostRecoveryAnalysis();

    // Step 3: Verify analysis ran and produced recommendations
    expect(result.analyzed).toBe(true);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.applied.length).toBeGreaterThan(0);

    // Step 4: Verify user notification exists
    expect(result.userNotification).toBeDefined();
    expect(result.userNotification).toContain("analyzed");

    // Step 5: Verify evolution was recorded
    const memoryAfter = await loadOagMemory();
    expect(memoryAfter.evolutions.length).toBeGreaterThan(0);
    expect(memoryAfter.evolutions[0].source).toBe("adaptive");
  });

  it("skips analysis when not enough crashes", async () => {
    // Only 1 crash — below threshold
    await recordLifecycleShutdown({
      startedAt: Date.now() - 60000,
      stopReason: "crash",
      metricsSnapshot: {},
      incidents: [],
    });

    const result = await runPostRecoveryAnalysis();
    expect(result.analyzed).toBe(false);
    expect(result.recommendations).toHaveLength(0);
  });

  it("respects evolution cooldown across restarts", async () => {
    const now = new Date().toISOString();

    // Simulate crashes
    for (let i = 0; i < 4; i++) {
      await recordLifecycleShutdown({
        startedAt: Date.now() - 60000,
        stopReason: "crash",
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

    // First postmortem runs
    const first = await runPostRecoveryAnalysis();
    expect(first.analyzed).toBe(true);

    // Second postmortem should be blocked by cooldown
    const second = await runPostRecoveryAnalysis();
    expect(second.analyzed).toBe(false);
  });
});
