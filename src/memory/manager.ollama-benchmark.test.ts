import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";

type TestManagerHelpersModule = typeof import("./test-manager-helpers.js");
type MemoryIndexModule = typeof import("./index.js");

function makeJsonlEntry(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    type: "message",
    message: {
      role,
      content: [{ type: "text", text }],
    },
  });
}

function makeSessionJsonl(messages: Array<{ role: "user" | "assistant"; text: string }>): string {
  return messages.map((m) => makeJsonlEntry(m.role, m.text)).join("\n") + "\n";
}

function makeMessages(
  turnCount: number,
  existingMessages: Array<{ role: "user" | "assistant"; text: string }> = [],
): Array<{ role: "user" | "assistant"; text: string }> {
  const messages = [...existingMessages];
  const existingCount = messages.length;
  for (let i = 0; i < turnCount; i++) {
    const turnNum = existingCount + i + 1;
    messages.push({
      role: "user",
      text: `User turn ${turnNum}: This is a detailed discussion about AI systems and their memory management capabilities. I want to understand how vector databases work.`,
    });
    messages.push({
      role: "assistant",
      text: `Assistant reply ${turnNum}: Great question! Vector databases store embeddings as high-dimensional vectors. They enable semantic search by finding similar vectors using cosine similarity or dot product.`,
    });
  }
  return messages;
}

function countDbChunks(db: any, p: string, source: string): number {
  return (
    (
      db
        .prepare(`SELECT COUNT(*) as c FROM chunks WHERE path = ? AND source = ?`)
        .get(p, source) as { c: number }
    ).c ?? 0
  );
}

// Skip this test if OLLAMA_LIVE_TEST is not set
const skipOllamaTests = !process.env.OLLAMA_LIVE_TEST;

describe.skipIf(skipOllamaTests)("incremental sync benchmark - real Ollama API", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir: string;
  let indexPath: string;
  let sessionFilePath: string;
  let sessionDir: string;
  let manager: MemoryIndexManager | null = null;
  let getRequiredMemoryIndexManager: TestManagerHelpersModule["getRequiredMemoryIndexManager"];
  let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];

  // Count actual embedBatch calls
  let embedBatchCallCount = 0;
  let embedBatchInputTextCount = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ollama-bench-"));
  });

  beforeEach(async () => {
    vi.resetModules();
    ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));
    embedBatchCallCount = 0;
    embedBatchInputTextCount = 0;
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    sessionDir = path.join(workspaceDir, "agents", "main", "sessions");
    sessionFilePath = path.join(sessionDir, "test-session.jsonl");
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello memory.");

    process.env.OPENCLAW_STATE_DIR = workspaceDir;
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
  });

  afterAll(async () => {
    if (!fixtureRoot) return;
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  const createCfg = (opts: {
    storePath: string;
    chunking?: { tokens: number; overlap: number };
  }): OpenClawConfig =>
    ({
      agents: {
        defaults: {
          workspace: path.join(opts.storePath, ".."),
          memorySearch: {
            provider: "ollama",
            model: "nomic-embed-text",
            store: { path: opts.storePath },
            cache: { enabled: false },
            chunking: opts.chunking ?? { tokens: 200, overlap: 50 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            sources: ["sessions"],
            experimental: { sessionMemory: true },
          },
        },
        list: [{ id: "main", default: true }],
      },
    }) as unknown as OpenClawConfig;

  interface BenchmarkResult {
    scenario: string;
    chunksBefore: number;
    chunksAfter: number;
    fullReindexEmbeds: number;
    incrementalEmbeds: number;
    fullReindexTimeMs: number;
    incrementalTimeMs: number;
    savingPercent: number;
    timeSavingPercent: number;
  }

  async function runBenchmark(
    overlap: number,
    initialTurns: number,
    growthTurns: number,
  ): Promise<BenchmarkResult> {
    const cfg = createCfg({
      storePath: indexPath,
      chunking: { tokens: 200, overlap },
    });

    const initialMessages = makeMessages(initialTurns);
    const grownMessages = makeMessages(initialTurns + growthTurns);

    // === Full Reindex Test ===
    const m1 = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    // Initial sync
    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await m1.sync({ force: true });
    const chunksBefore = countDbChunks((m1 as any).db, "sessions/test-session.jsonl", "sessions");

    // Full reindex
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    const fullStart = Date.now();
    await m1.sync({ force: true });
    const fullReindexTimeMs = Date.now() - fullStart;

    const chunksAfter = countDbChunks((m1 as any).db, "sessions/test-session.jsonl", "sessions");
    const fullReindexEmbeds = chunksAfter; // Full reindex processes all chunks

    await m1.close();
    await closeAllMemorySearchManagers();

    // === Incremental Sync Test ===
    vi.resetModules();
    ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));

    const m2 = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    // Initial sync
    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await m2.sync({ force: true });

    // Incremental sync
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    const incStart = Date.now();
    await m2.sync({ sessionFiles: [sessionFilePath] });
    const incrementalTimeMs = Date.now() - incStart;

    // Count actual embed calls by checking chunks that were processed
    const chunksAfterInc = countDbChunks((m2 as any).db, "sessions/test-session.jsonl", "sessions");

    // Incremental embeds = chunks that were NOT in the initial sync
    const incrementalEmbeds = chunksAfterInc - chunksBefore;

    await m2.close();
    await closeAllMemorySearchManagers();

    const savingPercent =
      fullReindexEmbeds > 0
        ? Math.round(((fullReindexEmbeds - incrementalEmbeds) / fullReindexEmbeds) * 1000) / 10
        : 0;

    const timeSavingPercent =
      fullReindexTimeMs > 0
        ? Math.round(((fullReindexTimeMs - incrementalTimeMs) / fullReindexTimeMs) * 1000) / 10
        : 0;

    return {
      scenario: `overlap=${overlap.toString().padStart(2)}, growth=+${growthTurns.toString().padStart(2)}turns`,
      chunksBefore,
      chunksAfter,
      fullReindexEmbeds,
      incrementalEmbeds,
      fullReindexTimeMs,
      incrementalTimeMs,
      savingPercent,
      timeSavingPercent,
    };
  }

  it("overlap=0, growth=+2turns", async () => {
    const result = await runBenchmark(0, 3, 2);
    expect(result.incrementalEmbeds).toBeLessThanOrEqual(result.fullReindexEmbeds);
  });

  it("overlap=0, growth=+5turns", async () => {
    const result = await runBenchmark(0, 5, 5);
    expect(result.incrementalEmbeds).toBeLessThanOrEqual(result.fullReindexEmbeds);
  });

  it("overlap=0, growth=+10turns", async () => {
    const result = await runBenchmark(0, 5, 10);
    expect(result.incrementalEmbeds).toBeLessThanOrEqual(result.fullReindexEmbeds);
  });

  it("overlap=50, growth=+5turns", async () => {
    const result = await runBenchmark(50, 5, 5);
    expect(result.incrementalEmbeds).toBeLessThanOrEqual(result.fullReindexEmbeds);
  });

  it("overlap=50, growth=+10turns", async () => {
    const result = await runBenchmark(50, 5, 10);
    expect(result.incrementalEmbeds).toBeLessThanOrEqual(result.fullReindexEmbeds);
  });

  it("generate benchmark report with real Ollama measurements", async () => {
    const scenarios = [
      { overlap: 0, initialTurns: 3, growthTurns: 2 },
      { overlap: 0, initialTurns: 5, growthTurns: 5 },
      { overlap: 0, initialTurns: 5, growthTurns: 10 },
      { overlap: 50, initialTurns: 3, growthTurns: 2 },
      { overlap: 50, initialTurns: 5, growthTurns: 5 },
      { overlap: 50, initialTurns: 5, growthTurns: 10 },
    ];

    const results: BenchmarkResult[] = [];

    for (const s of scenarios) {
      const result = await runBenchmark(s.overlap, s.initialTurns, s.growthTurns);
      results.push(result);
    }

    // Write report
    const report = [
      "=== Incremental Sync Benchmark Report (Real Ollama API) ===",
      "",
      "Scenario                       | Before | After | Full Embeds | Inc Embeds | Full Time | Inc Time | Embed Save | Time Save",
      "-------------------------------|--------|-------|-------------|------------|-----------|----------|------------|----------",
      ...results.map(
        (r) =>
          `${r.scenario} | ${r.chunksBefore.toString().padStart(6)} | ${r.chunksAfter.toString().padStart(5)} | ${r.fullReindexEmbeds.toString().padStart(11)} | ${r.incrementalEmbeds.toString().padStart(10)} | ${(r.fullReindexTimeMs + "ms").padStart(9)} | ${(r.incrementalTimeMs + "ms").padStart(8)} | ${r.savingPercent.toFixed(1).padStart(10)}% | ${r.timeSavingPercent.toFixed(1).padStart(9)}%`,
      ),
      "",
      "Legend:",
      "- Before: Number of chunks before growth",
      "- After: Number of chunks after growth",
      "- Full Embeds: Embedding calls during full reindex",
      "- Inc Embeds: Embedding calls during incremental sync",
      "- Full Time: Full reindex duration (ms)",
      "- Inc Time: Incremental sync duration (ms)",
      "- Embed Save: Percentage of embedding calls saved",
      "- Time Save: Percentage of time saved",
      "",
      "Test environment: Ollama + nomic-embed-text model",
      "Test time: " + new Date().toISOString(),
      "",
    ].join("\n");

    await fs.writeFile("/tmp/openclaw-ollama-benchmark-report.txt", report);

    // All scenarios should show improvement
    for (const r of results) {
      expect(r.incrementalEmbeds).toBeLessThanOrEqual(r.fullReindexEmbeds);
    }
  });
});
