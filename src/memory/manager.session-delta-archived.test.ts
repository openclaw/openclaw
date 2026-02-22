import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import { buildSessionEntry, sessionPathForFile } from "./session-files.js";

const { watchMock } = vi.hoisted(() => ({
  watchMock: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
  watch: watchMock,
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    },
  }),
}));

function createMemoryConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          experimental: { sessionMemory: true },
          sources: ["sessions"],
          provider: "openai",
          model: "mock-embed",
          store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
          sync: {
            watch: false,
            onSessionStart: false,
            onSearch: false,
            sessions: { deltaBytes: 999_999, deltaMessages: 999_999 },
          },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

describe("memory session delta archived paths", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";

  afterEach(async () => {
    watchMock.mockClear();
    vi.unstubAllEnvs();
    if (manager) {
      await manager.close();
      manager = null;
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
    }
  });

  it("marks archived transcripts dirty and syncs without delta-threshold checks", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-archived-delta-"));
    const stateDir = path.join(workspaceDir, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const cfg = createMemoryConfig(workspaceDir);

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;

    const archivedPath = path.join(sessionsDir, "session-1.jsonl.reset.2026-02-18T10-00-00.000Z");
    const inner = manager as unknown as {
      sessionPendingFiles: Set<string>;
      sessionsDirtyFiles: Set<string>;
      sessionsDirty: boolean;
      updateSessionDelta: (sessionFile: string) => Promise<unknown>;
      processSessionDeltaBatch: () => Promise<void>;
      sync: (params?: { reason?: string; force?: boolean }) => Promise<void>;
    };

    inner.sessionPendingFiles.add(archivedPath);
    const updateDeltaSpy = vi.spyOn(inner, "updateSessionDelta");
    const syncSpy = vi.fn(async () => undefined);
    inner.sync = syncSpy;

    await inner.processSessionDeltaBatch();

    expect(updateDeltaSpy).not.toHaveBeenCalled();
    expect(inner.sessionsDirtyFiles.has(archivedPath)).toBe(true);
    expect(inner.sessionsDirty).toBe(true);
    expect(syncSpy).toHaveBeenCalledWith({ reason: "session-delta" });
  });

  it("indexes newly discovered archived transcripts during dirty sync and skips unchanged reruns", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-archived-sync-"));
    const stateDir = path.join(workspaceDir, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const activePath = path.join(sessionsDir, "active.jsonl");
    const archivedPath = path.join(sessionsDir, "active.jsonl.reset.2026-02-18T10-00-00.000Z");
    await fs.writeFile(
      activePath,
      '{"type":"message","message":{"role":"user","content":"active message"}}\n',
      "utf-8",
    );
    await fs.writeFile(
      archivedPath,
      '{"type":"message","message":{"role":"assistant","content":"archived snapshot"}}\n',
      "utf-8",
    );

    const cfg = createMemoryConfig(workspaceDir);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;

    const activeEntry = await buildSessionEntry(activePath);
    expect(activeEntry).not.toBeNull();
    if (!activeEntry) {
      throw new Error("active session entry missing");
    }

    const inner = manager as unknown as {
      db: {
        prepare: (sql: string) => {
          run: (...params: unknown[]) => unknown;
          all: (...params: unknown[]) => Array<{ path: string }>;
        };
      };
      sessionsDirtyFiles: Set<string>;
      syncSessionFiles: (params: { needsFullReindex: boolean }) => Promise<void>;
      indexFile: (
        entry: { path: string },
        options: { source: string; content?: string },
      ) => Promise<void>;
    };

    inner.db
      .prepare("INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)")
      .run(
        activeEntry.path,
        "sessions",
        activeEntry.hash,
        Math.floor(activeEntry.mtimeMs),
        activeEntry.size,
      );

    inner.sessionsDirtyFiles.add(activePath);
    const indexSpy = vi.spyOn(inner, "indexFile");

    await inner.syncSessionFiles({ needsFullReindex: false });

    const firstRunIndexedPaths = indexSpy.mock.calls.map(([entry]) => entry.path);
    expect(firstRunIndexedPaths).toContain(sessionPathForFile(archivedPath));

    await inner.syncSessionFiles({ needsFullReindex: false });
    expect(indexSpy.mock.calls.length).toBe(firstRunIndexedPaths.length);
  });
});
