import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

type WatcherHandler = (p: string) => void;

const { watchMock } = vi.hoisted(() => {
  return {
    watchMock: vi.fn(() => {
      const handlers = new Map<string, WatcherHandler>();
      return {
        on: vi.fn((event: string, handler: WatcherHandler) => {
          handlers.set(event, handler);
        }),
        close: vi.fn(async () => undefined),
        _handlers: handlers,
      };
    }),
  };
});

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

describe("memory watcher config", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";
  let extraDir = "";

  afterEach(async () => {
    watchMock.mockClear();
    if (manager) {
      await manager.close();
      manager = null;
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      extraDir = "";
    }
  });

  async function createManager(opts?: { extraPaths?: string[] }) {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
            sync: { watch: true, watchDebounceMs: 25, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
            extraPaths: opts?.extraPaths ?? [],
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  it("watches workspace root and extra paths directly (not globs)", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-"));
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "notes.md"), "hello");

    await createManager({ extraPaths: [extraDir] });

    expect(watchMock).toHaveBeenCalledTimes(1);
    const [watchedPaths, options] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];

    // Should watch root directories directly, not glob patterns
    expect(watchedPaths).toContain(workspaceDir);
    expect(watchedPaths).toContain(extraDir);

    // Should NOT contain glob patterns (the old bug)
    for (const p of watchedPaths) {
      expect(p).not.toContain("**");
      expect(p).not.toContain("*.md");
    }

    expect(options.ignoreInitial).toBe(true);
    expect(options.awaitWriteFinish).toEqual({ stabilityThreshold: 25, pollInterval: 100 });

    const ignored = options.ignored as ((watchPath: string) => boolean) | undefined;
    expect(ignored).toBeTypeOf("function");
    expect(ignored?.(path.join(workspaceDir, "memory", "node_modules", "pkg", "index.md"))).toBe(
      true,
    );
    expect(ignored?.(path.join(workspaceDir, "memory", ".venv", "lib", "python.md"))).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.md"))).toBe(false);
  });

  it("markDirty filters: only memory paths in workspace trigger dirty", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-"));
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });

    await createManager();

    const mockWatcher = watchMock.mock.results[0]?.value as {
      _handlers: Map<string, WatcherHandler>;
    };
    const addHandler = mockWatcher._handlers.get("add");
    expect(addHandler).toBeTypeOf("function");

    if (!addHandler) {
      throw new Error("add handler not registered");
    }

    // memory/foo.md should trigger dirty
    addHandler(path.join(workspaceDir, "memory", "foo.md"));
    expect((manager as unknown as { dirty: boolean }).dirty).toBe(true);

    // Reset
    (manager as unknown as { dirty: boolean }).dirty = false;

    // MEMORY.md should trigger dirty
    addHandler(path.join(workspaceDir, "MEMORY.md"));
    expect((manager as unknown as { dirty: boolean }).dirty).toBe(true);

    // Reset
    (manager as unknown as { dirty: boolean }).dirty = false;

    // memory.md should trigger dirty
    addHandler(path.join(workspaceDir, "memory.md"));
    expect((manager as unknown as { dirty: boolean }).dirty).toBe(true);

    // Reset
    (manager as unknown as { dirty: boolean }).dirty = false;

    // src/foo.ts should NOT trigger dirty
    addHandler(path.join(workspaceDir, "src", "foo.ts"));
    expect((manager as unknown as { dirty: boolean }).dirty).toBe(false);

    // package.json should NOT trigger dirty
    addHandler(path.join(workspaceDir, "package.json"));
    expect((manager as unknown as { dirty: boolean }).dirty).toBe(false);
  });

  it("markDirty filters: markdown files in extra paths trigger dirty", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-"));
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "notes.md"), "hello");

    await createManager({ extraPaths: [extraDir] });

    const mockWatcher = watchMock.mock.results[0]?.value as {
      _handlers: Map<string, WatcherHandler>;
    };
    const addHandler = mockWatcher._handlers.get("add");
    expect(addHandler).toBeTypeOf("function");

    if (!addHandler) {
      throw new Error("add handler not registered");
    }

    // .md file in extra path should trigger dirty
    addHandler(path.join(extraDir, "notes.md"));
    expect((manager as unknown as { dirty: boolean }).dirty).toBe(true);

    // Reset
    (manager as unknown as { dirty: boolean }).dirty = false;

    // .txt file in extra path should NOT trigger dirty
    addHandler(path.join(extraDir, "data.txt"));
    expect((manager as unknown as { dirty: boolean }).dirty).toBe(false);
  });

  it("detects memory files created after watcher starts (late directory creation)", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-"));
    // NOTE: memory/ directory does NOT exist at watcher start time

    await createManager();

    const mockWatcher = watchMock.mock.results[0]?.value as {
      _handlers: Map<string, WatcherHandler>;
    };
    const addHandler = mockWatcher._handlers.get("add");
    expect(addHandler).toBeTypeOf("function");

    if (!addHandler) {
      throw new Error("add handler not registered");
    }

    // Simulate: memory/ directory is created later, then a file is added
    // Because we watch the workspace root (not a glob), chokidar detects this.
    // The handler correctly identifies it as a memory path via isMemoryPath().
    addHandler(path.join(workspaceDir, "memory", "new-note.md"));
    expect((manager as unknown as { dirty: boolean }).dirty).toBe(true);
  });
});
