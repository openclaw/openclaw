import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveSessionStoreTargets: vi.fn(),
  resolveMaintenanceConfig: vi.fn(),
  loadSessionStore: vi.fn(),
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
  pruneStaleEntries: vi.fn(),
  capEntryCount: vi.fn(),
  updateSessionStore: vi.fn(),
  enforceSessionDiskBudget: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("./session-store-targets.js", () => ({
  resolveSessionStoreTargets: mocks.resolveSessionStoreTargets,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMaintenanceConfig: mocks.resolveMaintenanceConfig,
  loadSessionStore: mocks.loadSessionStore,
  resolveSessionFilePath: mocks.resolveSessionFilePath,
  resolveSessionFilePathOptions: mocks.resolveSessionFilePathOptions,
  pruneStaleEntries: mocks.pruneStaleEntries,
  capEntryCount: mocks.capEntryCount,
  updateSessionStore: mocks.updateSessionStore,
  enforceSessionDiskBudget: mocks.enforceSessionDiskBudget,
}));

import { sessionsCleanupCommand } from "./sessions-cleanup.js";

function makeRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: () => {},
      exit: () => {},
    },
    logs,
  };
}

describe("sessionsCleanupCommand", () => {
  let tempDir = "";

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-cleanup-test-"));
    mocks.loadConfig.mockReturnValue({ session: { store: "/cfg/sessions.json" } });
    mocks.resolveSessionStoreTargets.mockReturnValue([
      { agentId: "main", storePath: "/resolved/sessions.json" },
    ]);
    mocks.resolveMaintenanceConfig.mockReturnValue({
      mode: "warn",
      pruneAfterMs: 7 * 24 * 60 * 60 * 1000,
      maxEntries: 500,
      rotateBytes: 10_485_760,
      resetArchiveRetentionMs: 7 * 24 * 60 * 60 * 1000,
      maxDiskBytes: null,
      highWaterBytes: null,
    });
    mocks.pruneStaleEntries.mockImplementation(
      (
        store: Record<string, SessionEntry>,
        _maxAgeMs: number,
        opts?: { onPruned?: (params: { key: string; entry: SessionEntry }) => void },
      ) => {
        if (store.stale) {
          opts?.onPruned?.({ key: "stale", entry: store.stale });
          delete store.stale;
          return 1;
        }
        return 0;
      },
    );
    mocks.resolveSessionFilePathOptions.mockReturnValue({});
    mocks.resolveSessionFilePath.mockImplementation(
      (sessionId: string) => `/missing/${sessionId}.jsonl`,
    );
    mocks.capEntryCount.mockImplementation(() => 0);
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.resolveSessionFilePathOptions.mockReturnValue({
      sessionsDir: "/resolved",
      agentId: "main",
    });
    mocks.resolveSessionFilePath.mockImplementation((sessionId: string) =>
      path.join("/resolved", `${sessionId}.jsonl`),
    );
    mocks.enforceSessionDiskBudget.mockResolvedValue({
      totalBytesBefore: 1000,
      totalBytesAfter: 700,
      removedFiles: 1,
      removedEntries: 1,
      freedBytes: 300,
      maxBytes: 900,
      highWaterBytes: 700,
      overBudget: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("emits a single JSON object for non-dry runs and applies maintenance", async () => {
    mocks.loadSessionStore
      .mockReturnValueOnce({
        stale: { sessionId: "stale", updatedAt: 1 },
        fresh: { sessionId: "fresh", updatedAt: 2 },
      })
      .mockReturnValueOnce({
        fresh: { sessionId: "fresh", updatedAt: 2 },
      });
    mocks.updateSessionStore.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, SessionEntry>) => Promise<void> | void,
        opts?: {
          onMaintenanceApplied?: (report: {
            mode: "warn" | "enforce";
            beforeCount: number;
            afterCount: number;
            pruned: number;
            capped: number;
            diskBudget: Record<string, unknown> | null;
          }) => Promise<void> | void;
        },
      ) => {
        await mutator({});
        await opts?.onMaintenanceApplied?.({
          mode: "enforce",
          beforeCount: 3,
          afterCount: 1,
          pruned: 0,
          capped: 2,
          diskBudget: {
            totalBytesBefore: 1200,
            totalBytesAfter: 800,
            removedFiles: 0,
            removedEntries: 0,
            freedBytes: 400,
            maxBytes: 1000,
            highWaterBytes: 800,
            overBudget: true,
          },
        });
        return 0;
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        enforce: true,
        activeKey: "agent:main:main",
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.applied).toBe(true);
    expect(payload.mode).toBe("enforce");
    expect(payload.beforeCount).toBe(3);
    expect(payload.appliedCount).toBe(1);
    expect(payload.pruned).toBe(0);
    expect(payload.capped).toBe(2);
    expect(payload.diskBudget).toEqual(
      expect.objectContaining({
        removedFiles: 0,
        removedEntries: 0,
      }),
    );
    expect(mocks.updateSessionStore).toHaveBeenCalledWith(
      "/resolved/sessions.json",
      expect.any(Function),
      expect.objectContaining({
        activeSessionKey: "agent:main:main",
        maintenanceOverride: { mode: "enforce" },
        onMaintenanceApplied: expect.any(Function),
      }),
    );
  });

  it("returns dry-run JSON without mutating the store", async () => {
    mocks.loadSessionStore.mockReturnValue({
      stale: { sessionId: "stale", updatedAt: 1 },
      fresh: { sessionId: "fresh", updatedAt: 2 },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        dryRun: true,
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.dryRun).toBe(true);
    expect(payload.applied).toBeUndefined();
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(payload.diskBudget).toEqual(
      expect.objectContaining({
        removedFiles: 1,
        removedEntries: 1,
      }),
    );
  });

  it("counts missing transcript entries when --fix-missing is enabled in dry-run", async () => {
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.loadSessionStore.mockReturnValue({
      missing: { sessionId: "missing-transcript", updatedAt: 1 },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        dryRun: true,
        fixMissing: true,
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.beforeCount).toBe(1);
    expect(payload.afterCount).toBe(0);
    expect(payload.missing).toBe(1);
  });

  it("renders a dry-run action table with keep/prune actions", async () => {
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.loadSessionStore.mockReturnValue({
      stale: { sessionId: "stale", updatedAt: 1, model: "pi:opus" },
      fresh: { sessionId: "fresh", updatedAt: 2, model: "pi:opus" },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        dryRun: true,
      },
      runtime,
    );

    expect(logs.some((line) => line.includes("Planned session actions:"))).toBe(true);
    expect(logs.some((line) => line.includes("Action") && line.includes("Key"))).toBe(true);
    expect(logs.some((line) => line.includes("fresh") && line.includes("keep"))).toBe(true);
    expect(logs.some((line) => line.includes("stale") && line.includes("prune-stale"))).toBe(true);
  });

  it("returns grouped JSON for --all-agents dry-runs", async () => {
    mocks.resolveSessionStoreTargets.mockReturnValue([
      { agentId: "main", storePath: "/resolved/main-sessions.json" },
      { agentId: "work", storePath: "/resolved/work-sessions.json" },
    ]);
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.loadSessionStore
      .mockReturnValueOnce({ stale: { sessionId: "stale-main", updatedAt: 1 } })
      .mockReturnValueOnce({ stale: { sessionId: "stale-work", updatedAt: 1 } });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        dryRun: true,
        allAgents: true,
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.allAgents).toBe(true);
    expect(Array.isArray(payload.stores)).toBe(true);
    expect((payload.stores as unknown[]).length).toBe(2);
  });

  it("marks and counts missing transcript entries in dry-run when --fix-missing is enabled", async () => {
    const existingTranscript = path.join(tempDir, "fresh.jsonl");
    fs.writeFileSync(existingTranscript, '{"type":"session"}\n', "utf-8");
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.loadSessionStore.mockReturnValue({
      missing: { sessionId: "missing", updatedAt: 2 },
      fresh: { sessionId: "fresh", updatedAt: 3 },
    });
    mocks.resolveSessionFilePath.mockImplementation((sessionId: string) =>
      path.join(tempDir, `${sessionId}.jsonl`),
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        dryRun: true,
        fixMissing: true,
      },
      runtime,
    );

    expect(logs.some((line) => line.includes("Would prune missing transcripts: 1"))).toBe(true);
    expect(logs.some((line) => line.includes("missing") && line.includes("prune-missing"))).toBe(
      true,
    );
  });

  it("keeps entries when transcript stat fails with non-missing errors", async () => {
    const blockedTranscript = path.join(tempDir, "blocked.jsonl");
    const freshTranscript = path.join(tempDir, "fresh.jsonl");
    fs.writeFileSync(blockedTranscript, '{"type":"session"}\n', "utf-8");
    fs.writeFileSync(freshTranscript, '{"type":"session"}\n', "utf-8");
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.loadSessionStore.mockReturnValue({
      blocked: { sessionId: "blocked", updatedAt: 2 },
      fresh: { sessionId: "fresh", updatedAt: 3 },
    });
    mocks.resolveSessionFilePath.mockImplementation((sessionId: string) =>
      path.join(tempDir, `${sessionId}.jsonl`),
    );

    const originalStatSync = fs.statSync;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((targetPath: fs.PathLike) => {
      if (String(targetPath) === blockedTranscript) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalStatSync(targetPath);
    }) as typeof fs.statSync);

    try {
      const { runtime, logs } = makeRuntime();
      await sessionsCleanupCommand(
        {
          dryRun: true,
          fixMissing: true,
        },
        runtime,
      );

      expect(logs.some((line) => line.includes("Would prune missing transcripts: 0"))).toBe(true);
      expect(logs.some((line) => line.includes("blocked") && line.includes("prune-missing"))).toBe(
        false,
      );
      expect(logs.some((line) => line.includes("blocked") && line.includes("keep"))).toBe(true);
    } finally {
      statSpy.mockRestore();
    }
  });

  it("reports missing transcript prune count in applied JSON output", async () => {
    const existingTranscript = path.join(tempDir, "fresh.jsonl");
    fs.writeFileSync(existingTranscript, '{"type":"session"}\n', "utf-8");
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.loadSessionStore
      .mockReturnValueOnce({
        missing: { sessionId: "missing", updatedAt: 2 },
        fresh: { sessionId: "fresh", updatedAt: 3 },
      })
      .mockReturnValueOnce({
        fresh: { sessionId: "fresh", updatedAt: 3 },
      });
    mocks.resolveSessionFilePath.mockImplementation((sessionId: string) =>
      path.join(tempDir, `${sessionId}.jsonl`),
    );
    mocks.updateSessionStore.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, SessionEntry>) => Promise<void> | void,
      ) => {
        await mutator({
          missing: { sessionId: "missing", updatedAt: 2 },
          fresh: { sessionId: "fresh", updatedAt: 3 },
        });
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        fixMissing: true,
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.applied).toBe(true);
    expect(payload.missing).toBe(1);
  });
});
