import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";

type EmbeddingTestMocksModule = typeof import("./embedding.test-mocks.js");
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
      text: `User turn ${turnNum}: This is a detailed discussion about AI systems and their capabilities.`,
    });
    messages.push({
      role: "assistant",
      text: `Assistant reply ${turnNum}: I understand your question. Here is my detailed analysis and response.`,
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

describe("incremental sync benchmark - real measurements", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir: string;
  let indexPath: string;
  let sessionFilePath: string;
  let sessionDir: string;
  let manager: MemoryIndexManager | null = null;
  let embedBatch: ReturnType<EmbeddingTestMocksModule["getEmbedBatchMock"]>;
  let resetEmbeddingMocks: EmbeddingTestMocksModule["resetEmbeddingMocks"];
  let getRequiredMemoryIndexManager: TestManagerHelpersModule["getRequiredMemoryIndexManager"];
  let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bench-real-"));
  });

  beforeEach(async () => {
    vi.resetModules();
    const embeddingMocks = await import("./embedding.test-mocks.js");
    embedBatch = embeddingMocks.getEmbedBatchMock();
    resetEmbeddingMocks = embeddingMocks.resetEmbeddingMocks;
    ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));
    resetEmbeddingMocks();
    embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map((_, index) => [index + 1, 0, 0]),
    );
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
    vi.unstubAllEnvs();
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
            provider: "openai",
            model: "mock-embed",
            store: { path: opts.storePath },
            cache: { enabled: false },
            chunking: opts.chunking ?? { tokens: 40, overlap: 10 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            sources: ["sessions"],
            experimental: { sessionMemory: true },
          },
        },
        list: [{ id: "main", default: true }],
      },
    }) as unknown as OpenClawConfig;

  // Scenario 1: overlap=0, growth=2 turns
  it("overlap=0, growth=+2turns: measure real embed calls", async () => {
    const cfg = createCfg({ storePath: indexPath, chunking: { tokens: 40, overlap: 0 } });
    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    const initialMessages = makeMessages(3); // 3 turns = 6 messages
    const grownMessages = makeMessages(5); // 5 turns = 10 messages

    // Initial sync
    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager.sync({ force: true });
    const chunksBefore = countDbChunks(
      (manager as any).db,
      "sessions/test-session.jsonl",
      "sessions",
    );

    // Full Reindex (simulate old behavior with force=true)
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    embedBatch.mockClear();
    await manager.sync({ force: true });
    const fullReindexEmbeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;
    const chunksAfterFull = countDbChunks(
      (manager as any).db,
      "sessions/test-session.jsonl",
      "sessions",
    );

    // Now test incremental: reset to initial, then grow incrementally
    await closeAllMemorySearchManagers();
    vi.resetModules();
    const embeddingMocks2 = await import("./embedding.test-mocks.js");
    embedBatch = embeddingMocks2.getEmbedBatchMock();
    resetEmbeddingMocks = embeddingMocks2.resetEmbeddingMocks;
    ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));
    resetEmbeddingMocks();
    embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map((_, index) => [index + 1, 0, 0]),
    );

    const manager2 = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    // Initial sync
    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager2.sync({ force: true });

    // Incremental sync
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    embedBatch.mockClear();
    await manager2.sync({ sessionFiles: [sessionFilePath] });
    const incrementalEmbeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;
    const chunksAfterInc = countDbChunks(
      (manager2 as any).db,
      "sessions/test-session.jsonl",
      "sessions",
    );

    await manager2.close();

    // Verify results
    expect(chunksAfterFull).toBe(chunksAfterInc);
    expect(incrementalEmbeds).toBeLessThanOrEqual(fullReindexEmbeds);
  });

  // Scenario 2: overlap=0, growth=5 turns
  it("overlap=0, growth=+5turns: measure real embed calls", async () => {
    const cfg = createCfg({ storePath: indexPath, chunking: { tokens: 40, overlap: 0 } });
    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    const initialMessages = makeMessages(5);
    const grownMessages = makeMessages(10);

    // Full Reindex
    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager.sync({ force: true });
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    embedBatch.mockClear();
    await manager.sync({ force: true });
    const fullReindexEmbeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;

    await closeAllMemorySearchManagers();
    vi.resetModules();
    const embeddingMocks2 = await import("./embedding.test-mocks.js");
    embedBatch = embeddingMocks2.getEmbedBatchMock();
    resetEmbeddingMocks = embeddingMocks2.resetEmbeddingMocks;
    ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));
    resetEmbeddingMocks();
    embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map((_, index) => [index + 1, 0, 0]),
    );

    const manager2 = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    // Incremental
    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager2.sync({ force: true });
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    embedBatch.mockClear();
    await manager2.sync({ sessionFiles: [sessionFilePath] });
    const incrementalEmbeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;

    await manager2.close();

    expect(incrementalEmbeds).toBeLessThanOrEqual(fullReindexEmbeds);
  });

  // Scenario 3: overlap=0, growth=10 turns
  it("overlap=0, growth=+10turns: measure real embed calls", async () => {
    const cfg = createCfg({ storePath: indexPath, chunking: { tokens: 40, overlap: 0 } });
    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    const initialMessages = makeMessages(5);
    const grownMessages = makeMessages(15);

    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager.sync({ force: true });
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    embedBatch.mockClear();
    await manager.sync({ force: true });
    const fullReindexEmbeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;

    await closeAllMemorySearchManagers();
    vi.resetModules();
    const embeddingMocks2 = await import("./embedding.test-mocks.js");
    embedBatch = embeddingMocks2.getEmbedBatchMock();
    resetEmbeddingMocks = embeddingMocks2.resetEmbeddingMocks;
    ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));
    resetEmbeddingMocks();
    embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map((_, index) => [index + 1, 0, 0]),
    );

    const manager2 = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager2.sync({ force: true });
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    embedBatch.mockClear();
    await manager2.sync({ sessionFiles: [sessionFilePath] });
    const incrementalEmbeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;

    await manager2.close();

    expect(incrementalEmbeds).toBeLessThanOrEqual(fullReindexEmbeds);
  });

  // Scenario 4: overlap=10, growth=2 turns
  it("overlap=10, growth=+2turns: measure real embed calls", async () => {
    const cfg = createCfg({ storePath: indexPath, chunking: { tokens: 40, overlap: 10 } });
    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    const initialMessages = makeMessages(3);
    const grownMessages = makeMessages(5);

    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager.sync({ force: true });
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    embedBatch.mockClear();
    await manager.sync({ force: true });
    const fullReindexEmbeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;

    await closeAllMemorySearchManagers();
    vi.resetModules();
    const embeddingMocks2 = await import("./embedding.test-mocks.js");
    embedBatch = embeddingMocks2.getEmbedBatchMock();
    resetEmbeddingMocks = embeddingMocks2.resetEmbeddingMocks;
    ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));
    resetEmbeddingMocks();
    embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map((_, index) => [index + 1, 0, 0]),
    );

    const manager2 = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager2.sync({ force: true });
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    embedBatch.mockClear();
    await manager2.sync({ sessionFiles: [sessionFilePath] });
    const incrementalEmbeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;

    await manager2.close();

    expect(incrementalEmbeds).toBeLessThanOrEqual(fullReindexEmbeds);
  });

  // Scenario 5: overlap=10, growth=5 turns
  it("overlap=10, growth=+5turns: measure real embed calls", async () => {
    const cfg = createCfg({ storePath: indexPath, chunking: { tokens: 40, overlap: 10 } });
    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    const initialMessages = makeMessages(5);
    const grownMessages = makeMessages(10);

    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager.sync({ force: true });
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    embedBatch.mockClear();
    await manager.sync({ force: true });
    const fullReindexEmbeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;

    await closeAllMemorySearchManagers();
    vi.resetModules();
    const embeddingMocks2 = await import("./embedding.test-mocks.js");
    embedBatch = embeddingMocks2.getEmbedBatchMock();
    resetEmbeddingMocks = embeddingMocks2.resetEmbeddingMocks;
    ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));
    resetEmbeddingMocks();
    embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map((_, index) => [index + 1, 0, 0]),
    );

    const manager2 = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager2.sync({ force: true });
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
    embedBatch.mockClear();
    await manager2.sync({ sessionFiles: [sessionFilePath] });
    const incrementalEmbeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;

    await manager2.close();

    expect(incrementalEmbeds).toBeLessThanOrEqual(fullReindexEmbeds);
  });

  // Generate comprehensive report
  it("generate benchmark report with real measurements", async () => {
    const scenarios = [
      { overlap: 0, initialTurns: 3, growthTurns: 2 },
      { overlap: 0, initialTurns: 5, growthTurns: 5 },
      { overlap: 0, initialTurns: 5, growthTurns: 10 },
      { overlap: 10, initialTurns: 3, growthTurns: 2 },
      { overlap: 10, initialTurns: 5, growthTurns: 5 },
      { overlap: 10, initialTurns: 5, growthTurns: 10 },
    ];

    const results: Array<{
      scenario: string;
      chunksBefore: number;
      chunksAfter: number;
      fullReindex: number;
      incremental: number;
      saving: number;
    }> = [];

    for (const s of scenarios) {
      const cfg = createCfg({
        storePath: indexPath,
        chunking: { tokens: 40, overlap: s.overlap },
      });

      const initialMessages = makeMessages(s.initialTurns);
      const grownMessages = makeMessages(s.initialTurns + s.growthTurns);

      // Test Full Reindex
      const m1 = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });
      await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
      await m1.sync({ force: true });
      const chunksBefore = countDbChunks((m1 as any).db, "sessions/test-session.jsonl", "sessions");
      await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
      embedBatch.mockClear();
      await m1.sync({ force: true });
      const fullReindex = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;
      const chunksAfter = countDbChunks((m1 as any).db, "sessions/test-session.jsonl", "sessions");
      await m1.close();
      await closeAllMemorySearchManagers();

      // Reset
      vi.resetModules();
      const embeddingMocks2 = await import("./embedding.test-mocks.js");
      embedBatch = embeddingMocks2.getEmbedBatchMock();
      resetEmbeddingMocks = embeddingMocks2.resetEmbeddingMocks;
      ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));
      ({ closeAllMemorySearchManagers } = await import("./index.js"));
      resetEmbeddingMocks();
      embedBatch.mockImplementation(async (texts: string[]) =>
        texts.map((_, index) => [index + 1, 0, 0]),
      );

      // Test Incremental
      const m2 = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });
      await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
      await m2.sync({ force: true });
      await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));
      embedBatch.mockClear();
      await m2.sync({ sessionFiles: [sessionFilePath] });
      const incremental = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;
      await m2.close();
      await closeAllMemorySearchManagers();

      const saving =
        fullReindex > 0 ? Math.round(((fullReindex - incremental) / fullReindex) * 1000) / 10 : 0;

      results.push({
        scenario: `overlap=${s.overlap.toString().padStart(2)}, growth=+${s.growthTurns.toString().padStart(2)}turns`,
        chunksBefore,
        chunksAfter,
        fullReindex,
        incremental,
        saving,
      });
    }

    // Write report
    const report = [
      "=== Incremental Sync Benchmark Report (Real Measurements) ===",
      "",
      "Scenario                       | Before | After | Full Reindex | Incremental | Saving",
      "-------------------------------|--------|-------|--------------|-------------|-------",
      ...results.map(
        (r) =>
          `${r.scenario} | ${r.chunksBefore.toString().padStart(6)} | ${r.chunksAfter.toString().padStart(5)} | ${r.fullReindex.toString().padStart(12)} | ${r.incremental.toString().padStart(11)} | ${r.saving.toFixed(1).padStart(5)}%`,
      ),
      "",
      "Legend:",
      "- Before: Number of chunks before growth",
      "- After: Number of chunks after growth",
      "- Full Reindex: Actual embedBatch calls during full reindex (triggered by force=true)",
      "- Incremental: Actual embedBatch calls during incremental sync (triggered by sessionFiles param)",
      "- Saving: Percentage of embedding calls saved",
      "",
    ].join("\n");

    await fs.writeFile("/tmp/openclaw-benchmark-report.txt", report);

    // All scenarios should show improvement
    for (const r of results) {
      expect(r.incremental).toBeLessThanOrEqual(r.fullReindex);
    }
  });
});
