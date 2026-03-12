import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";
import { getRequiredMemoryIndexManager } from "./test-manager-helpers.js";
import "./test-runtime-mocks.js";

function encodeText(text: string): number[] {
  const lower = text.toLowerCase();
  const alpha = lower.split("alpha").length - 1;
  const zebra = lower.split("zebra").length - 1;
  const session = lower.split("session").length - 1;
  return [alpha, zebra, session];
}

const mockState = vi.hoisted(() => ({
  mode: "none" as "none" | "mock",
  embedBatch: vi.fn(),
  embedQuery: vi.fn(),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async (options: { provider?: string; model?: string }) => {
    if (mockState.mode === "none") {
      return {
        requestedProvider: options.provider ?? "auto",
        provider: null,
        providerUnavailableReason: 'No API key found for provider "openai"',
      };
    }
    const model = options.model ?? "mock-embed";
    return {
      requestedProvider: options.provider ?? "openai",
      provider: {
        id: "mock",
        model,
        maxInputTokens: 8192,
        embedQuery: mockState.embedQuery,
        embedBatch: mockState.embedBatch,
      },
    };
  },
}));

describe("memory manager fts-only indexing", () => {
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  function createCfg(params?: {
    sources?: Array<"memory" | "sessions">;
    sessionMemory?: boolean;
    provider?: "auto" | "openai";
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: params?.provider ?? "auto",
            model: "mock-embed",
            fallback: "none",
            store: { path: indexPath, vector: { enabled: false } },
            cache: { enabled: false },
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: {
              minScore: 0,
              hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
            },
            sources: params?.sources,
            experimental: { sessionMemory: params?.sessionMemory ?? false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  function countRows(
    managerInstance: MemoryIndexManager,
    sql: string,
    ...params: unknown[]
  ): number {
    const db = (
      managerInstance as unknown as {
        db: {
          prepare: (statement: string) => {
            get: (...statementParams: unknown[]) => { c?: number } | undefined;
          };
        };
      }
    ).db;
    const row = db.prepare(sql).get(...params) as { c?: number } | undefined;
    return row?.c ?? 0;
  }

  function setDirty(managerInstance: MemoryIndexManager): void {
    (managerInstance as unknown as { dirty: boolean }).dirty = true;
  }

  async function createManager(cfg: OpenClawConfig): Promise<MemoryIndexManager> {
    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });
    return manager;
  }

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");
    vi.unstubAllGlobals();
    mockState.mode = "none";
    mockState.embedBatch.mockReset();
    mockState.embedQuery.mockReset();
    mockState.embedBatch.mockImplementation(async (texts: string[]) => texts.map(encodeText));
    mockState.embedQuery.mockImplementation(async (text: string) => encodeText(text));
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
  });

  afterEach(async () => {
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

  it("indexes markdown memory files in fts-only mode and searches via FTS", async () => {
    const activeManager = await createManager(createCfg());
    await activeManager.sync({ reason: "test" });

    const status = activeManager.status();
    expect(status.provider).toBe("none");
    expect(status.custom?.searchMode).toBe("fts-only");
    expect(status.files).toBe(1);
    expect(status.chunks).toBeGreaterThan(0);
    expect(countRows(activeManager, "SELECT COUNT(*) as c FROM chunks")).toBeGreaterThan(0);
    expect(
      countRows(activeManager, "SELECT COUNT(*) as c FROM chunks_fts WHERE model = ?", "fts-only"),
    ).toBeGreaterThan(0);
    expect(mockState.embedBatch).not.toHaveBeenCalled();

    const results = await activeManager.search("zebra");
    expect(results.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
  });

  it("indexes session transcripts in fts-only mode", async () => {
    const stateDir = path.join(workspaceDir, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session-1.jsonl"),
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Session fallback topic" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Session recall detail" }],
          },
        }),
      ].join("\n"),
    );

    const activeManager = await createManager(
      createCfg({
        sources: ["memory", "sessions"],
        sessionMemory: true,
      }),
    );
    await activeManager.sync({ reason: "test" });

    const status = activeManager.status();
    const sessionCounts = status.sourceCounts?.find((entry) => entry.source === "sessions");
    expect(sessionCounts?.files).toBe(1);
    expect(sessionCounts?.chunks ?? 0).toBeGreaterThan(0);
    expect(
      countRows(
        activeManager,
        "SELECT COUNT(*) as c FROM chunks_fts WHERE source = ? AND model = ?",
        "sessions",
        "fts-only",
      ),
    ).toBeGreaterThan(0);

    const results = await activeManager.search("fallback");
    expect(results.some((entry) => entry.path === "sessions/session-1.jsonl")).toBe(true);
  });

  it("cleans stale fts-only rows on resync", async () => {
    const activeManager = await createManager(createCfg());
    const memoryPath = path.join(workspaceDir, "memory", "2026-01-12.md");

    await activeManager.sync({ reason: "test" });
    expect(countRows(activeManager, "SELECT COUNT(*) as c FROM files")).toBe(1);
    expect(countRows(activeManager, "SELECT COUNT(*) as c FROM chunks_fts")).toBeGreaterThan(0);

    await fs.rm(memoryPath, { force: true });
    setDirty(activeManager);
    await activeManager.sync({ reason: "test" });

    expect(countRows(activeManager, "SELECT COUNT(*) as c FROM files")).toBe(0);
    expect(countRows(activeManager, "SELECT COUNT(*) as c FROM chunks")).toBe(0);
    expect(countRows(activeManager, "SELECT COUNT(*) as c FROM chunks_fts")).toBe(0);
    await expect(activeManager.search("zebra")).resolves.toEqual([]);
  });

  it("keeps provider-backed indexing behavior unchanged", async () => {
    mockState.mode = "mock";
    const activeManager = await createManager(createCfg({ provider: "openai" }));
    await activeManager.sync({ reason: "test" });

    const status = activeManager.status();
    expect(status.provider).toBe("mock");
    expect(status.custom?.searchMode).toBe("hybrid");
    expect(mockState.embedBatch).toHaveBeenCalled();
    expect(
      countRows(
        activeManager,
        "SELECT COUNT(*) as c FROM chunks_fts WHERE model = ?",
        "mock-embed",
      ),
    ).toBeGreaterThan(0);

    const results = await activeManager.search("zebra");
    expect(results.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
  });
});
