import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeConfig,
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  getMemorySearchManager,
  loadShortTermPromotionDreamingStats,
  invokeDoctorMemory,
  respondPayload,
  makeDreamingStats,
  makeDreamingEntry,
  useMemoryManagerFixture,
} from "./doctor.test-support.js";

// Only the dreaming provider lookup is replaced; every other memory-state
// export stays real.
const resolveActiveMemoryDreamingStatus = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock("../../plugins/memory-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/memory-state.js")>()),
  resolveActiveMemoryDreamingStatus,
}));

describe("doctor.memory.status with a memory slot owner's dreaming provider", () => {
  beforeEach(() => {
    resolveActiveMemoryDreamingStatus.mockReset().mockResolvedValue(null);
    getRuntimeConfig.mockReset().mockReturnValue({});
    resolveAgentWorkspaceDir.mockReset().mockReturnValue("/tmp/openclaw");
    resolveMemorySearchConfig.mockReset().mockReturnValue({ enabled: true });
    getMemorySearchManager.mockReset();
    loadShortTermPromotionDreamingStats
      .mockReset()
      .mockImplementation(async () => makeDreamingStats());
  });

  it("reports a slot owner's dreaming status even when no search manager exists", async () => {
    getMemorySearchManager.mockResolvedValue({ manager: null, error: "memory search unavailable" });
    resolveActiveMemoryDreamingStatus.mockResolvedValueOnce({
      enabled: true,
      timezone: "Europe/Berlin",
      phases: {
        light: { enabled: true, scheduled: true, cron: "" },
        deep: { enabled: false, scheduled: false },
        rem: { enabled: true, scheduled: true, cron: "15 1 * * *", nextRunAtMs: 1_000 },
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: {} });

    const payload = respondPayload(respond) as Record<string, unknown>;
    // The search diagnostic stays exactly as before.
    expect(payload.embedding).toEqual({ ok: false, error: "memory search unavailable" });
    const dreaming = payload.dreaming as Record<string, any>;
    expect(dreaming.reportedEnabled).toBe(true);
    expect(dreaming.reportedByProvider).toBe(true);
    expect(dreaming.timezone).toBe("Europe/Berlin");
    expect(dreaming.phases.rem).toMatchObject({
      cron: "15 1 * * *",
      managedCronPresent: true,
      nextRunAtMs: 1_000,
    });
    expect(dreaming.phases.light).toMatchObject({ cron: "", managedCronPresent: true });
    expect(dreaming.shortTermCount).toBe(0);
  });

  it("keeps the host timezone while the slot owner reports only some phases", async () => {
    // The one timezone labels every phase row; a provider that leaves a phase
    // to the host must not relabel that phase's cron with its own zone.
    getMemorySearchManager.mockResolvedValue({ manager: null, error: "memory search unavailable" });
    resolveActiveMemoryDreamingStatus.mockResolvedValueOnce({
      timezone: "Asia/Tokyo",
      phases: { rem: { enabled: true, scheduled: true, cron: "15 1 * * *" } },
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: {} });

    const dreaming = (respondPayload(respond) as Record<string, any>).dreaming;
    expect(dreaming.reportedByProvider).toBe(true);
    expect(dreaming.timezone).not.toBe("Asia/Tokyo");
    expect(dreaming.phases.rem.cron).toBe("15 1 * * *");
  });

  it("keeps reported counters apart from memory-core's figures and entry lists", async () => {
    useMemoryManagerFixture({ status: () => ({ provider: "gemini" }) });
    const waiting = makeDreamingEntry("memory/2026-09-25.md", { snippet: "memory-core candidate" });
    loadShortTermPromotionDreamingStats.mockImplementation(async () =>
      makeDreamingStats({ shortTermCount: 1, promotedToday: 2, shortTermEntries: [waiting] }),
    );
    const stats = {
      shortTermCount: 9,
      promotedTotal: 40,
      promotedToday: 4,
      lastPromotedAt: "2026-09-25T06:00:00.000Z",
    };
    resolveActiveMemoryDreamingStatus.mockResolvedValueOnce({ enabled: true, stats });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: {} });

    const dreaming = (respondPayload(respond) as Record<string, any>).dreaming;
    expect(dreaming.reportedStats).toEqual(stats);
    // memory-core's count still describes memory-core's list.
    expect(dreaming.shortTermCount).toBe(1);
    expect(dreaming.promotedToday).toBe(2);
    expect(dreaming.shortTermEntries).toMatchObject([{ path: "memory/2026-09-25.md" }]);
    expect(dreaming.lastPromotedAt).toBeUndefined();
  });

  it("keeps the configuration toggle apart from the enablement a slot owner reports", async () => {
    getRuntimeConfig.mockReturnValue({
      plugins: {
        slots: { memory: "memory-core" },
        entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
      },
    });
    getMemorySearchManager.mockResolvedValue({ manager: null, error: "memory search unavailable" });
    resolveActiveMemoryDreamingStatus.mockResolvedValueOnce({ enabled: true });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: {} });

    const dreaming = (respondPayload(respond) as Record<string, any>).dreaming;
    // `enabled` is what the page's toggle writes; the report must not mask it.
    expect(dreaming.enabled).toBe(false);
    expect(dreaming.reportedEnabled).toBe(true);
  });

  it("drops the memory-core sweep's next run from phases whose schedule the slot owner reports", async () => {
    getMemorySearchManager.mockResolvedValue({ manager: null, error: "memory search unavailable" });
    resolveActiveMemoryDreamingStatus.mockResolvedValueOnce({
      phases: {
        light: { enabled: true, scheduled: true, cron: "", lastRunAtMs: 500 },
        rem: { enabled: true, scheduled: true, cron: "15 1 * * *", nextRunAtMs: 2_000 },
      },
    });
    const cronList = vi.fn(async () => [
      {
        name: "Memory Dreaming Promotion",
        description: "[managed-by=memory-core.short-term-promotion] test",
        enabled: true,
        payload: {
          kind: "systemEvent",
          text: "__openclaw_memory_core_short_term_promotion_dream__",
        },
        state: { nextRunAtMs: 9_000 },
      },
    ]);
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: {}, cronList });

    const phases = (respondPayload(respond) as Record<string, any>).dreaming.phases;
    // Event-driven phase: the sweep's timestamp is not its schedule.
    expect(phases.light).toMatchObject({ cron: "", managedCronPresent: true, lastRunAtMs: 500 });
    expect(phases.light).not.toHaveProperty("nextRunAtMs");
    // A reported next run wins over the sweep's.
    expect(phases.rem).toMatchObject({ cron: "15 1 * * *", nextRunAtMs: 2_000 });
    // A phase the provider does not report keeps the host resolution.
    expect(phases.deep).toMatchObject({ managedCronPresent: true, nextRunAtMs: 9_000 });
  });

  it("marks a phases-only report as provider-owned without inventing enablement", async () => {
    getMemorySearchManager.mockResolvedValue({ manager: null, error: "memory search unavailable" });
    resolveActiveMemoryDreamingStatus.mockResolvedValueOnce({
      phases: { rem: { enabled: true, scheduled: true, cron: "15 1 * * *" } },
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: {} });

    const dreaming = (respondPayload(respond) as Record<string, any>).dreaming;
    // Presence is what locks the page's switch; enablement stays unknown.
    expect(dreaming.reportedByProvider).toBe(true);
    expect(dreaming).not.toHaveProperty("reportedEnabled");
  });

  it("keeps the no-manager response unchanged when no dreaming provider reports", async () => {
    getMemorySearchManager.mockResolvedValue({ manager: null, error: "memory search unavailable" });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: {} });

    const payload = respondPayload(respond) as Record<string, unknown>;
    expect(payload.dreaming).toBeUndefined();
  });
});
