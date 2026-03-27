import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";

let failPattern: string | null = null;

type EmbeddingTestMocksModule = typeof import("./embedding.test-mocks.js");
type TestManagerHelpersModule = typeof import("./test-manager-helpers.js");
type MemoryIndexModule = typeof import("./index.js");
type TestMemorySource = "memory" | "sessions";

describe("memory manager atomic reindex", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;
  let embedBatch: ReturnType<EmbeddingTestMocksModule["getEmbedBatchMock"]>;
  let resetEmbeddingMocks: EmbeddingTestMocksModule["resetEmbeddingMocks"];
  let getRequiredMemoryIndexManager: TestManagerHelpersModule["getRequiredMemoryIndexManager"];
  let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-atomic-"));
  });

  beforeEach(async () => {
    vi.resetModules();
    const embeddingMocks = await import("./embedding.test-mocks.js");
    embedBatch = embeddingMocks.getEmbedBatchMock();
    resetEmbeddingMocks = embeddingMocks.resetEmbeddingMocks;
    ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "0");
    resetEmbeddingMocks();
    failPattern = null;
    embedBatch.mockImplementation(async (texts: string[]) => {
      if (failPattern && texts.some((text) => text.includes(failPattern!))) {
        throw new Error("embedding failure");
      }
      return texts.map((_, index) => [index + 1, 0, 0]);
    });
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello memory.");
    await fs.writeFile(path.join(workspaceDir, "memory", "broken.md"), "Broken memory.");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  const createCfg = (params?: { sources?: TestMemorySource[] }) =>
    ({
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            cache: { enabled: false },
            // Perf: keep test indexes to a single chunk to reduce sqlite work.
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            ...(params?.sources
              ? {
                  sources: params.sources,
                  experimental: { sessionMemory: true },
                }
              : {}),
          },
        },
        list: [{ id: "main", default: true }],
      },
    }) as OpenClawConfig;

  const createManager = async (params?: { sources?: TestMemorySource[] }) => {
    manager = await getRequiredMemoryIndexManager({
      cfg: createCfg(params),
      agentId: "main",
    });
    return manager;
  };

  const writeTranscript = async (filePath: string, text: string) => {
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text }] },
      })}\n`,
    );
  };

  it("preserves the previous index when a safe full reindex fails", async () => {
    manager = await createManager();

    await manager.sync({ force: true });
    const beforeStatus = manager.status();
    expect(beforeStatus.files).toBe(2);
    expect(beforeStatus.chunks).toBeGreaterThan(0);

    await fs.writeFile(path.join(workspaceDir, "memory", "broken.md"), "Broken failure trigger.");
    failPattern = "failure trigger";
    await expect(manager.sync({ force: true })).rejects.toThrow("embedding failure");

    const afterStatus = manager.status();
    expect(afterStatus.files).toBe(2);
    expect(afterStatus.chunks).toBeGreaterThan(0);
  });

  it("rolls back unsafe full reindexes when fast-test mode hits a partial failure", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");

    manager = await createManager();

    await manager.sync({ force: true });
    const beforeStatus = manager.status();
    expect(beforeStatus.files).toBe(2);
    expect(beforeStatus.chunks).toBeGreaterThan(0);

    await fs.writeFile(path.join(workspaceDir, "memory", "broken.md"), "Broken failure trigger.");
    failPattern = "failure trigger";
    await expect(manager.sync({ force: true })).rejects.toThrow("embedding failure");

    const afterStatus = manager.status();
    expect(afterStatus.files).toBe(2);
    expect(afterStatus.chunks).toBeGreaterThan(0);
  });

  it("retries rolled-back memory work after an aborted safe forced reindex", async () => {
    const stateDir = path.join(fixtureRoot, `state-rollback-memory-${randomUUID()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const sessionPath = path.join(sessionDir, "rollback-memory.jsonl");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      await fs.mkdir(sessionDir, { recursive: true });
      await writeTranscript(sessionPath, "rollback memory session v1");

      manager = await createManager({ sources: ["memory", "sessions"] });

      await manager.sync({ force: true });

      const internal = manager as unknown as {
        db: {
          prepare: (sql: string) => {
            get: (path: string, source: string) => { hash: string } | undefined;
          };
        };
        indexFile: (
          entry: { path: string },
          options: { source: "memory" | "sessions" },
        ) => Promise<void>;
      };
      const getMemoryHash = (memoryRelPath: string) =>
        internal.db
          .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
          .get(memoryRelPath, "memory")?.hash;
      const brokenMemoryRelPath = "memory/broken.md";
      const originalBrokenHash = getMemoryHash(brokenMemoryRelPath);

      await fs.writeFile(
        path.join(workspaceDir, "memory", "broken.md"),
        "Broken memory updated before rolled-back reindex.",
      );

      const originalIndexFile = internal.indexFile.bind(manager);
      internal.indexFile = async (entry, options) => {
        if (options.source === "sessions") {
          throw new Error("local session reindex failure");
        }
        await originalIndexFile(entry, options);
      };

      await expect(manager.sync({ force: true })).rejects.toThrow("local session reindex failure");

      expect(getMemoryHash(brokenMemoryRelPath)).toBe(originalBrokenHash);
      expect(manager.status().dirty).toBe(true);

      internal.indexFile = originalIndexFile;
      await manager.sync({ reason: "retry" });

      expect(getMemoryHash(brokenMemoryRelPath)).not.toBe(originalBrokenHash);
      expect(manager.status().dirty).toBe(false);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("retries all rolled-back session files after an aborted safe forced reindex", async () => {
    const stateDir = path.join(fixtureRoot, `state-rollback-sessions-${randomUUID()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const firstSessionPath = path.join(sessionDir, "rollback-first.jsonl");
    const secondSessionPath = path.join(sessionDir, "rollback-second.jsonl");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      await fs.mkdir(sessionDir, { recursive: true });
      await writeTranscript(firstSessionPath, "rollback first transcript v1");
      await writeTranscript(secondSessionPath, "rollback second transcript v1");

      manager = await createManager({ sources: ["sessions"] });

      await manager.sync({ force: true });

      const internal = manager as unknown as {
        sessionsDirty: boolean;
        sessionsDirtyFiles: Set<string>;
        db: {
          prepare: (sql: string) => {
            get: (path: string, source: string) => { hash: string } | undefined;
          };
        };
        indexFile: (
          entry: { path: string },
          options: { source: "memory" | "sessions" },
        ) => Promise<void>;
      };
      const getSessionHash = (sessionRelPath: string) =>
        internal.db
          .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
          .get(sessionRelPath, "sessions")?.hash;
      const firstSessionRelPath = "sessions/rollback-first.jsonl";
      const secondSessionRelPath = "sessions/rollback-second.jsonl";
      const firstOriginalHash = getSessionHash(firstSessionRelPath);
      const secondOriginalHash = getSessionHash(secondSessionRelPath);

      await writeTranscript(firstSessionPath, "rollback first transcript v2");
      await writeTranscript(secondSessionPath, "rollback second transcript v2");

      const attemptedSessionPaths = new Set<string>();
      const originalIndexFile = internal.indexFile.bind(manager);
      let sessionAttemptCount = 0;
      internal.indexFile = async (entry, options) => {
        if (options.source === "sessions") {
          attemptedSessionPaths.add(entry.path);
          sessionAttemptCount += 1;
          if (sessionAttemptCount === 2) {
            throw new Error("local session reindex failure");
          }
        }
        await originalIndexFile(entry, options);
      };

      await expect(manager.sync({ force: true })).rejects.toThrow("local session reindex failure");

      expect(attemptedSessionPaths).toEqual(new Set([firstSessionRelPath, secondSessionRelPath]));
      expect(getSessionHash(firstSessionRelPath)).toBe(firstOriginalHash);
      expect(getSessionHash(secondSessionRelPath)).toBe(secondOriginalHash);
      expect(internal.sessionsDirtyFiles.has(firstSessionPath)).toBe(true);
      expect(internal.sessionsDirtyFiles.has(secondSessionPath)).toBe(true);
      expect(internal.sessionsDirty).toBe(true);

      internal.indexFile = originalIndexFile;
      await manager.sync({ reason: "retry" });

      expect(getSessionHash(firstSessionRelPath)).not.toBe(firstOriginalHash);
      expect(getSessionHash(secondSessionRelPath)).not.toBe(secondOriginalHash);
      expect(internal.sessionsDirtyFiles.has(firstSessionPath)).toBe(false);
      expect(internal.sessionsDirtyFiles.has(secondSessionPath)).toBe(false);
      expect(internal.sessionsDirty).toBe(false);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps session reindex dirty after an aborted safe forced reindex before a result is produced", async () => {
    const stateDir = path.join(fixtureRoot, `state-rollback-sessions-early-${randomUUID()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const sessionPath = path.join(sessionDir, "rollback-early.jsonl");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      await fs.mkdir(sessionDir, { recursive: true });
      await writeTranscript(sessionPath, "rollback early transcript v1");

      manager = await createManager({ sources: ["sessions"] });

      await manager.sync({ force: true });

      const internal = manager as unknown as {
        sessionsDirty: boolean;
        sessionsDirtyFiles: Set<string>;
        db: {
          prepare: (sql: string) => {
            get: (path: string, source: string) => { hash: string } | undefined;
          };
        };
        syncSessionFiles: (params: {
          needsFullReindex: boolean;
          progress?: unknown;
        }) => Promise<unknown>;
      };
      const getSessionHash = (sessionRelPath: string) =>
        internal.db
          .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
          .get(sessionRelPath, "sessions")?.hash;
      const sessionRelPath = "sessions/rollback-early.jsonl";
      const originalHash = getSessionHash(sessionRelPath);

      await writeTranscript(sessionPath, "rollback early transcript v2");

      const originalSyncSessionFiles = internal.syncSessionFiles.bind(manager);
      internal.syncSessionFiles = async (params) => {
        if (params.needsFullReindex) {
          throw new Error("session reindex aborted early");
        }
        return await originalSyncSessionFiles(params);
      };

      await expect(manager.sync({ force: true })).rejects.toThrow("session reindex aborted early");

      expect(getSessionHash(sessionRelPath)).toBe(originalHash);
      expect(internal.sessionsDirty).toBe(true);
      expect(internal.sessionsDirtyFiles.size).toBe(0);

      internal.syncSessionFiles = originalSyncSessionFiles;
      await manager.sync({ reason: "retry" });

      expect(getSessionHash(sessionRelPath)).not.toBe(originalHash);
      expect(internal.sessionsDirty).toBe(false);
      expect(internal.sessionsDirtyFiles.size).toBe(0);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves dirty updates that arrive while a safe forced reindex is rolling back", async () => {
    const stateDir = path.join(fixtureRoot, `state-rollback-live-updates-${randomUUID()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const firstSessionPath = path.join(sessionDir, "rollback-live-first.jsonl");
    const secondSessionPath = path.join(sessionDir, "rollback-live-second.jsonl");
    const lateSessionPath = path.join(sessionDir, "rollback-live-late.jsonl");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      await fs.mkdir(sessionDir, { recursive: true });
      await writeTranscript(firstSessionPath, "rollback live first v1");
      await writeTranscript(secondSessionPath, "rollback live second v1");

      manager = await createManager({ sources: ["sessions"] });

      await manager.sync({ force: true });
      await writeTranscript(firstSessionPath, "rollback live first v2");
      await writeTranscript(secondSessionPath, "rollback live second v2");

      const internal = manager as unknown as {
        dirty: boolean;
        sessionsDirty: boolean;
        sessionsDirtyFiles: Set<string>;
        sessionDeltas: Map<
          string,
          { lastSize: number; pendingBytes: number; pendingMessages: number }
        >;
        indexFile: (
          entry: { path: string },
          options: { source: "memory" | "sessions" },
        ) => Promise<void>;
      };
      const originalIndexFile = internal.indexFile.bind(manager);

      internal.indexFile = async (entry, options) => {
        if (options.source === "sessions" && entry.path === "sessions/rollback-live-second.jsonl") {
          await writeTranscript(lateSessionPath, "rollback live late update");
          internal.dirty = true;
          internal.sessionsDirty = true;
          internal.sessionsDirtyFiles.add(lateSessionPath);
          internal.sessionDeltas.set(lateSessionPath, {
            lastSize: 0,
            pendingBytes: 32,
            pendingMessages: 1,
          });
          throw new Error("local session reindex failure");
        }
        await originalIndexFile(entry, options);
      };

      await expect(manager.sync({ force: true })).rejects.toThrow("local session reindex failure");

      expect(manager.status().dirty).toBe(true);
      expect(internal.sessionsDirty).toBe(true);
      expect(internal.sessionsDirtyFiles.has(lateSessionPath)).toBe(true);
      expect(internal.sessionDeltas.get(lateSessionPath)).toEqual({
        lastSize: 0,
        pendingBytes: 32,
        pendingMessages: 1,
      });

      internal.indexFile = originalIndexFile;
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
