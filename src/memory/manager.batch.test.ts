import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import { createOpenAIEmbeddingProviderMock } from "./test-embeddings-mock.js";
import "./test-runtime-mocks.js";

const embedBatch = vi.fn(async (_texts: string[]) => [] as number[][]);
const embedQuery = vi.fn(async () => [0.5, 0.5, 0.5]);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () =>
    createOpenAIEmbeddingProviderMock({
      embedQuery,
      embedBatch,
    }),
}));

describe("memory indexing with OpenAI batches", () => {
  let fixtureRoot: string;
  let workspaceDir: string;
  let memoryDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  function useFastShortTimeouts() {
    const realSetTimeout = setTimeout;
    const spy = vi.spyOn(global, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const delay = typeof timeout === "number" ? timeout : 0;
      if (delay > 0 && delay <= 2000) {
        return realSetTimeout(handler, 0, ...args);
      }
      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout);
    return () => spy.mockRestore();
  }

  async function readOpenAIBatchUploadRequests(body: FormData) {
    let uploadedRequests: Array<{ custom_id?: string }> = [];
    const entries = body.entries() as IterableIterator<[string, FormDataEntryValue]>;
    for (const [key, value] of entries) {
      if (key !== "file") {
        continue;
      }
      const text = typeof value === "string" ? value : await value.text();
      uploadedRequests = text
        .split("\n")
        .filter(Boolean)
        .map((line: string) => JSON.parse(line) as { custom_id?: string });
    }
    return uploadedRequests;
  }

  function createOpenAIBatchFetchMock(options?: {
    onCreateBatch?: (ctx: { batchCreates: number }) => Response | Promise<Response>;
  }) {
    let uploadedRequests: Array<{ custom_id?: string }> = [];
    const state = { batchCreates: 0 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/files")) {
        const body = init?.body;
        if (!(body instanceof FormData)) {
          throw new Error("expected FormData upload");
        }
        uploadedRequests = await readOpenAIBatchUploadRequests(body);
        return new Response(JSON.stringify({ id: "file_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/batches")) {
        state.batchCreates += 1;
        if (options?.onCreateBatch) {
          return await options.onCreateBatch({ batchCreates: state.batchCreates });
        }
        return new Response(JSON.stringify({ id: "batch_1", status: "in_progress" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/batches/batch_1")) {
        return new Response(
          JSON.stringify({ id: "batch_1", status: "completed", output_file_id: "file_out" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/files/file_out/content")) {
        const lines = uploadedRequests.map((request, index) =>
          JSON.stringify({
            custom_id: request.custom_id,
            response: {
              status_code: 200,
              body: { data: [{ embedding: [index + 1, 0, 0], index: 0 }] },
            },
          }),
        );
        return new Response(lines.join("\n"), {
          status: 200,
          headers: { "Content-Type": "application/jsonl" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    return { fetchMock, state };
  }

  function createBatchCfg(): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
            remote: { batch: { enabled: true, wait: true, pollIntervalMs: 1 } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-batch-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    indexPath = path.join(fixtureRoot, "index.sqlite");
    await fs.mkdir(memoryDir, { recursive: true });

    const result = await getMemorySearchManager({ cfg: createBatchCfg(), agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
  });

  afterAll(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    embedBatch.mockClear();
    embedQuery.mockClear();
    embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map((_text, index) => [index + 1, 0, 0]),
    );

    await fs.rm(memoryDir, { recursive: true, force: true });
    await fs.mkdir(memoryDir, { recursive: true });

    // Reuse one manager instance across tests; keep index state isolated.
    if (!manager) {
      throw new Error("manager missing");
    }
    (manager as unknown as { resetIndex: () => void }).resetIndex();
    (manager as unknown as { dirty: boolean }).dirty = true;
    (manager as unknown as { batchFailureCount: number }).batchFailureCount = 0;
    (manager as unknown as { batchFailureLastError?: string }).batchFailureLastError = undefined;
    (manager as unknown as { batchFailureLastProvider?: string }).batchFailureLastProvider =
      undefined;
    (manager as unknown as { batch: { enabled: boolean } }).batch.enabled = true;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
  });

  it("uses OpenAI batch uploads when enabled", async () => {
    const restoreTimeouts = useFastShortTimeouts();
    const content = ["hello", "from", "batch"].join("\n\n");
    await fs.writeFile(path.join(memoryDir, "2026-01-07.md"), content);

    const { fetchMock } = createOpenAIBatchFetchMock();

    vi.stubGlobal("fetch", fetchMock);

    try {
      if (!manager) {
        throw new Error("manager missing");
      }
      const labels: string[] = [];
      await manager.sync({
        progress: (update) => {
          if (update.label) {
            labels.push(update.label);
          }
        },
      });

      const status = manager.status();
      expect(status.chunks).toBeGreaterThan(0);
      expect(embedBatch).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalled();
      expect(labels.some((label) => label.toLowerCase().includes("batch"))).toBe(true);
    } finally {
      restoreTimeouts();
    }
  });

  it("retries OpenAI batch create on transient failures", async () => {
    const restoreTimeouts = useFastShortTimeouts();
    const content = ["retry", "the", "batch"].join("\n\n");
    await fs.writeFile(path.join(memoryDir, "2026-01-08.md"), content);

    const { fetchMock, state } = createOpenAIBatchFetchMock({
      onCreateBatch: ({ batchCreates }) => {
        if (batchCreates === 1) {
          return new Response("upstream connect error", { status: 503 });
        }
        return new Response(JSON.stringify({ id: "batch_1", status: "in_progress" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    vi.stubGlobal("fetch", fetchMock);

    try {
      if (!manager) {
        throw new Error("manager missing");
      }
      await manager.sync({ reason: "test" });

      const status = manager.status();
      expect(status.chunks).toBeGreaterThan(0);
      expect(state.batchCreates).toBe(2);
    } finally {
      restoreTimeouts();
    }
  });

  it("tracks batch failures, resets on success, and disables after repeated failures", async () => {
    const restoreTimeouts = useFastShortTimeouts();
    const memoryFile = path.join(memoryDir, "2026-01-09.md");
    await fs.writeFile(memoryFile, ["flaky", "batch"].join("\n\n"));
    let mtimeMs = Date.now();
    const touch = async () => {
      mtimeMs += 1_000;
      const date = new Date(mtimeMs);
      await fs.utimes(memoryFile, date, date);
    };
    await touch();

    let mode: "fail" | "ok" = "fail";
    const { fetchMock } = createOpenAIBatchFetchMock({
      onCreateBatch: () =>
        mode === "fail"
          ? new Response("batch failed", { status: 400 })
          : new Response(JSON.stringify({ id: "batch_1", status: "in_progress" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
    });

    vi.stubGlobal("fetch", fetchMock);

    try {
      if (!manager) {
        throw new Error("manager missing");
      }

      // First failure: fallback to regular embeddings and increment failure count.
      await manager.sync({ reason: "test" });
      expect(embedBatch).toHaveBeenCalled();
      let status = manager.status();
      expect(status.batch?.enabled).toBe(true);
      expect(status.batch?.failures).toBe(1);

      // Success should reset failure count.
      embedBatch.mockClear();
      mode = "ok";
      await fs.writeFile(memoryFile, ["flaky", "batch", "recovery"].join("\n\n"));
      await touch();
      (manager as unknown as { dirty: boolean }).dirty = true;
      await manager.sync({ reason: "test" });
      status = manager.status();
      expect(status.batch?.enabled).toBe(true);
      expect(status.batch?.failures).toBe(0);
      expect(embedBatch).not.toHaveBeenCalled();

      // Two more failures after reset should disable remote batching.
      await (
        manager as unknown as {
          recordBatchFailure: (params: {
            provider: string;
            message: string;
            attempts?: number;
            forceDisable?: boolean;
          }) => Promise<unknown>;
        }
      ).recordBatchFailure({ provider: "openai", message: "batch failed", attempts: 1 });
      await (
        manager as unknown as {
          recordBatchFailure: (params: {
            provider: string;
            message: string;
            attempts?: number;
            forceDisable?: boolean;
          }) => Promise<unknown>;
        }
      ).recordBatchFailure({ provider: "openai", message: "batch failed", attempts: 1 });
      status = manager.status();
      expect(status.batch?.enabled).toBe(false);
      expect(status.batch?.failures).toBeGreaterThanOrEqual(2);

      // Once disabled, batch endpoints are skipped and fallback embeddings run directly.
      const fetchCalls = fetchMock.mock.calls.length;
      embedBatch.mockClear();
      await fs.writeFile(memoryFile, ["flaky", "batch", "fallback"].join("\n\n"));
      await touch();
      (manager as unknown as { dirty: boolean }).dirty = true;
      await manager.sync({ reason: "test" });
      expect(fetchMock.mock.calls.length).toBe(fetchCalls);
      expect(embedBatch).toHaveBeenCalled();
    } finally {
      restoreTimeouts();
    }
  });
});
