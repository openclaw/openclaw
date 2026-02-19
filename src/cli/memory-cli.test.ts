import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const getMemorySearchManager = vi.fn();
const loadConfig = vi.fn(() => ({}));
const resolveDefaultAgentId = vi.fn(() => "main");

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager,
}));

vi.mock("../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
}));

let registerMemoryCli: typeof import("./memory-cli.js").registerMemoryCli;
let defaultRuntime: typeof import("../runtime.js").defaultRuntime;
let isVerbose: typeof import("../globals.js").isVerbose;
let setVerbose: typeof import("../globals.js").setVerbose;

beforeAll(async () => {
  ({ registerMemoryCli } = await import("./memory-cli.js"));
  ({ defaultRuntime } = await import("../runtime.js"));
  ({ isVerbose, setVerbose } = await import("../globals.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  getMemorySearchManager.mockReset();
  process.exitCode = undefined;
  setVerbose(false);
});

describe("memory cli", () => {
  function expectCliSync(sync: ReturnType<typeof vi.fn>) {
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", force: false, progress: expect.any(Function) }),
    );
  }

  function makeMemoryStatus(overrides: Record<string, unknown> = {}) {
    return {
      files: 0,
      chunks: 0,
      dirty: false,
      workspaceDir: "/tmp/openclaw",
      dbPath: "/tmp/memory.sqlite",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
      vector: { enabled: true, available: true },
      ...overrides,
    };
  }

  function mockManager(manager: Record<string, unknown>) {
    getMemorySearchManager.mockResolvedValueOnce({ manager });
  }

  async function runMemoryCli(args: string[]) {
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", ...args], { from: "user" });
  }

  async function withQmdIndexDb(content: string, run: (dbPath: string) => Promise<void>) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-qmd-index-"));
    const dbPath = path.join(tmpDir, "index.sqlite");
    try {
      await fs.writeFile(dbPath, content, "utf-8");
      await run(dbPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async function expectCloseFailureAfterCommand(params: {
    args: string[];
    manager: Record<string, unknown>;
    beforeExpect?: () => void;
  }) {
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    mockManager({ ...params.manager, close });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    await runMemoryCli(params.args);

    params.beforeExpect?.();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  }

  it("prints vector status when available", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () =>
        makeMemoryStatus({
          files: 2,
          chunks: 5,
          cache: { enabled: true, entries: 123, maxEntries: 50000 },
          fts: { enabled: true, available: true },
          vector: {
            enabled: true,
            available: true,
            extensionPath: "/opt/sqlite-vec.dylib",
            dims: 1024,
          },
        }),
      close,
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: ready"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector dims: 1024"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector path: /opt/sqlite-vec.dylib"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FTS: ready"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Embedding cache: enabled (123 entries)"),
    );
    expect(close).toHaveBeenCalled();
  });

  it("prints vector error when unavailable", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => false),
      status: () =>
        makeMemoryStatus({
          dirty: true,
          vector: {
            enabled: true,
            available: false,
            loadError: "load failed",
          },
        }),
      close,
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["status", "--agent", "main"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector error: load failed"));
    expect(close).toHaveBeenCalled();
  });

  it("prints embeddings status when deep", async () => {
    const close = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["status", "--deep"]);

    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Embeddings: ready"));
    expect(close).toHaveBeenCalled();
  });

  it("enables verbose logging with --verbose", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus(),
      close,
    });

    await runMemoryCli(["status", "--verbose"]);

    expect(isVerbose()).toBe(true);
  });

  it("logs close failure after status", async () => {
    await expectCloseFailureAfterCommand({
      args: ["status"],
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      },
    });
  });

  it("reindexes on status --index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      sync,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["status", "--index"]);

    expectCliSync(sync);
    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("closes manager after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    mockManager({ sync, close });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["index"]);

    expectCliSync(sync);
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory index updated (main).");
  });

  it("logs qmd index file path and size after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("sqlite-bytes", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("QMD index: "));
      expect(log).toHaveBeenCalledWith("Memory index updated (main).");
      expect(close).toHaveBeenCalled();
    });
  });

  it("fails index when qmd db file is empty", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Memory index failed (main): QMD index file is empty"),
      );
      expect(close).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  it("logs close failures without failing the command", async () => {
    const sync = vi.fn(async () => {});
    await expectCloseFailureAfterCommand({
      args: ["index"],
      manager: { sync },
      beforeExpect: () => {
        expectCliSync(sync);
      },
    });
  });

  it("logs close failure after search", async () => {
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    await expectCloseFailureAfterCommand({
      args: ["search", "hello"],
      manager: { search },
      beforeExpect: () => {
        expect(search).toHaveBeenCalled();
      },
    });
  });

  it("closes manager after search error", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => {
      throw new Error("boom");
    });
    mockManager({ search, close });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    await runMemoryCli(["search", "oops"]);

    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Memory search failed: boom"));
    expect(process.exitCode).toBe(1);
  });
});
