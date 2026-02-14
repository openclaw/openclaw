import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = vi.fn(async () => []);
const embedQuery = vi.fn(async () => [0.5, 0.5, 0.5]);

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery,
      embedBatch,
    },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  }),
}));

describe("memory indexing with OpenAI batches", () => {
  let fixtureRoot: string;
  let caseId = 0;
  let workspaceDir: string;
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

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-batch-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    embedBatch.mockClear();
    embedQuery.mockClear();
    embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map((_text, index) => [index + 1, 0, 0]),
    );
    workspaceDir = path.join(fixtureRoot, `case-${++caseId}`);
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (manager) {
      await manager.close();
      manager = null;
    }
  });

  it("uses OpenAI batch uploads when enabled", async () => {
    const restoreTimeouts = useFastShortTimeouts();
    const content = ["hello", "from", "batch"].join("\n\n");
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-07.md"), content);

    let uploadedRequests: Array<{ custom_id?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/files")) {
        const body = init?.body;
        if (!(body instanceof FormData)) {
          throw new Error("expected FormData upload");
        }
        for (const [key, value] of body.entries()) {
          if (key !== "file") {
            continue;
          }
          if (typeof value === "string") {
            uploadedRequests = value
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { custom_id?: string });
          } else {
            const text = await value.text();
            uploadedRequests = text
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { custom_id?: string });
          }
        }
        return new Response(JSON.stringify({ id: "file_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/batches")) {
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

    vi.stubGlobal("fetch", fetchMock);

    const cfg = {
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
    };

    try {
      const result = await getMemorySearchManager({ cfg, agentId: "main" });
      expect(result.manager).not.toBeNull();
      if (!result.manager) {
        throw new Error("manager missing");
      }
      manager = result.manager;
      const labels: string[] = [];
      await manager.sync({
        force: true,
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
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-08.md"), content);

    let uploadedRequests: Array<{ custom_id?: string }> = [];
    let batchCreates = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/files")) {
        const body = init?.body;
        if (!(body instanceof FormData)) {
          throw new Error("expected FormData upload");
        }
        for (const [key, value] of body.entries()) {
          if (key !== "file") {
            continue;
          }
          if (typeof value === "string") {
            uploadedRequests = value
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { custom_id?: string });
          } else {
            const text = await value.text();
            uploadedRequests = text
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { custom_id?: string });
          }
        }
        return new Response(JSON.stringify({ id: "file_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/batches")) {
        batchCreates += 1;
        if (batchCreates === 1) {
          return new Response("upstream connect error", { status: 503 });
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

    vi.stubGlobal("fetch", fetchMock);

    const cfg = {
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
    };

    try {
      const result = await getMemorySearchManager({ cfg, agentId: "main" });
      expect(result.manager).not.toBeNull();
      if (!result.manager) {
        throw new Error("manager missing");
      }
      manager = result.manager;
      await manager.sync({ force: true });

      const status = manager.status();
      expect(status.chunks).toBeGreaterThan(0);
      expect(batchCreates).toBe(2);
    } finally {
      restoreTimeouts();
    }
  });

  it("tracks batch failures, resets on success, and disables after repeated failures", async () => {
    const restoreTimeouts = useFastShortTimeouts();
    const content = ["flaky", "batch"].join("\n\n");
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-09.md"), content);

    let uploadedRequests: Array<{ custom_id?: string }> = [];
    let mode: "fail" | "ok" = "fail";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/files")) {
        const body = init?.body;
        if (!(body instanceof FormData)) {
          throw new Error("expected FormData upload");
        }
        for (const [key, value] of body.entries()) {
          if (key !== "file") {
            continue;
          }
          if (typeof value === "string") {
            uploadedRequests = value
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { custom_id?: string });
          } else {
            const text = await value.text();
            uploadedRequests = text
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { custom_id?: string });
          }
        }
        return new Response(JSON.stringify({ id: "file_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/batches")) {
        if (mode === "fail") {
          return new Response("batch failed", { status: 400 });
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

    vi.stubGlobal("fetch", fetchMock);

    const cfg = {
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
    };

    try {
      const result = await getMemorySearchManager({ cfg, agentId: "main" });
      expect(result.manager).not.toBeNull();
      if (!result.manager) {
        throw new Error("manager missing");
      }
      manager = result.manager;

      // First failure: fallback to regular embeddings and increment failure count.
      await manager.sync({ force: true });
      expect(embedBatch).toHaveBeenCalled();
      let status = manager.status();
      expect(status.batch?.enabled).toBe(true);
      expect(status.batch?.failures).toBe(1);

      // Success should reset failure count.
      embedBatch.mockClear();
      mode = "ok";
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-01-09.md"),
        ["flaky", "batch", "recovery"].join("\n\n"),
      );
      await manager.sync({ force: true });
      status = manager.status();
      expect(status.batch?.enabled).toBe(true);
      expect(status.batch?.failures).toBe(0);
      expect(embedBatch).not.toHaveBeenCalled();

      // Two more failures after reset should disable remote batching.
      mode = "fail";
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-01-09.md"),
        ["flaky", "batch", "fail-a"].join("\n\n"),
      );
      await manager.sync({ force: true });
      status = manager.status();
      expect(status.batch?.enabled).toBe(true);
      expect(status.batch?.failures).toBe(1);

      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-01-09.md"),
        ["flaky", "batch", "fail-b"].join("\n\n"),
      );
      await manager.sync({ force: true });
      status = manager.status();
      expect(status.batch?.enabled).toBe(false);
      expect(status.batch?.failures).toBeGreaterThanOrEqual(2);

      // Once disabled, batch endpoints are skipped and fallback embeddings run directly.
      const fetchCalls = fetchMock.mock.calls.length;
      embedBatch.mockClear();
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-01-09.md"),
        ["flaky", "batch", "fallback"].join("\n\n"),
      );
      await manager.sync({ force: true });
      expect(fetchMock.mock.calls.length).toBe(fetchCalls);
      expect(embedBatch).toHaveBeenCalled();
    } finally {
      restoreTimeouts();
    }
  });
});
