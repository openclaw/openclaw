/**
 * Regression test: hybrid mode multi-word keyword search.
 *
 * Before the fix, `searchKeyword` was called once with the full raw query (e.g.
 * "Rocky Point bagging"), which produced an FTS5 AND query:
 *   "Rocky" AND "Point" AND "bagging"
 * This required all tokens in the same 400-token chunk. When "Rocky Point" and
 * "bagging" landed in separate chunks the query returned 0 FTS hits — even with
 * 17+ matching instances spread across indexed files.
 *
 * The fix mirrors the FTS-only mode: extract individual keywords, search each
 * separately, then merge by highest score (OR-style recall).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";
import { createMemoryManagerOrThrow } from "./test-manager.js";
import "./test-runtime-mocks.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      // Flat embeddings — zero semantic signal so keyword search is the only signal.
      embedQuery: async () => [0, 0, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [0, 0, 0]),
    },
  }),
}));

describe("hybrid keyword search — multi-word queries find cross-chunk terms", () => {
  let workspaceDir: string;
  let memoryDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hybrid-kw-"));
    memoryDir = path.join(workspaceDir, "memory");
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(memoryDir, { recursive: true });

    // Write a file where each meaningful term is on its own line so small chunk
    // sizes guarantee the terms land in separate chunks.
    await fs.writeFile(
      path.join(memoryDir, "business.md"),
      [
        "# Business Units",
        "Rocky Point is a key distribution site.",
        "The bagging operations run three shifts daily.",
        "Core business unit for retail garden products.",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  function createCfg(chunkTokens: number): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            // Tiny chunks so "Rocky Point" and "bagging" land in different rows.
            chunking: { tokens: chunkTokens, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: {
              minScore: 0,
              hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  it("finds documents when query tokens span separate chunks (hybrid mode)", async () => {
    // Use 8-token chunks so each line becomes its own chunk.
    manager = await createMemoryManagerOrThrow(createCfg(8));
    const status = manager.status();
    if (!status.fts?.available) {
      // FTS not available in this environment; skip.
      return;
    }

    await manager.sync({ reason: "test" });

    // Each of these terms lives in a different chunk. The strict AND query
    // ("Rocky" AND "Point" AND "bagging") would return 0; per-keyword search returns hits.
    const results = await manager.search("Rocky Point bagging");
    expect(results.length).toBeGreaterThan(0);
  });

  it("finds documents for two-word queries that span chunks (hybrid mode)", async () => {
    manager = await createMemoryManagerOrThrow(createCfg(8));
    const status = manager.status();
    if (!status.fts?.available) {
      return;
    }

    await manager.sync({ reason: "test" });

    const results1 = await manager.search("bagging operations");
    expect(results1.length).toBeGreaterThan(0);

    const results2 = await manager.search("retail garden products");
    expect(results2.length).toBeGreaterThan(0);
  });
});
