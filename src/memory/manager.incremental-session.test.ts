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

function makeGrowingMessages(
  turnCount: number,
  existingMessages: Array<{ role: "user" | "assistant"; text: string }> = [],
): Array<{ role: "user" | "assistant"; text: string }> {
  const messages = [...existingMessages];
  const existingCount = messages.length;
  for (let i = 0; i < turnCount; i++) {
    const turnNum = existingCount + i + 1;
    messages.push({
      role: "user",
      text: `User turn ${turnNum}: Discussion about topic ${turnNum}.`,
    });
    messages.push({
      role: "assistant",
      text: `Assistant reply ${turnNum}: Response about topic ${turnNum}.`,
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

describe("incremental session sync - final metrics", () => {
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
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-final-"));
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

  it("unchanged file should skip all re-embedding", async () => {
    const cfg = createCfg({ storePath: indexPath, chunking: { tokens: 40, overlap: 0 } });
    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    // First sync
    const messages = makeGrowingMessages(3);
    await fs.writeFile(sessionFilePath, makeSessionJsonl(messages));
    await manager.sync({ force: true });
    const r1Chunks = countDbChunks((manager as any).db, "sessions/test-session.jsonl", "sessions");

    // Second sync WITHOUT file change
    embedBatch.mockClear();
    await manager.sync({ sessionFiles: [sessionFilePath] });
    const r2Embeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;

    // Key assertion: NO re-embedding for unchanged file
    expect(r2Embeds).toBe(0);
  });

  it("growing session with overlap=0 should only embed new chunks", async () => {
    const cfg = createCfg({ storePath: indexPath, chunking: { tokens: 40, overlap: 0 } });
    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    // First sync: 3 turns
    const initialMessages = makeGrowingMessages(3);
    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager.sync({ force: true });
    const r1Chunks = countDbChunks((manager as any).db, "sessions/test-session.jsonl", "sessions");

    // Grow session: add 2 more turns
    const grownMessages = makeGrowingMessages(2, initialMessages);
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));

    // Second sync: incremental
    embedBatch.mockClear();
    await manager.sync({ sessionFiles: [sessionFilePath] });
    const r2Embeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;
    const r2Chunks = countDbChunks((manager as any).db, "sessions/test-session.jsonl", "sessions");

    // Key assertion: only new chunks embedded
    const newChunks = r2Chunks - r1Chunks;
    expect(r2Embeds).toBeLessThanOrEqual(newChunks + 1); // +1 for boundary
  });

  it("growing session with overlap=10 should embed new + boundary chunks", async () => {
    const cfg = createCfg({ storePath: indexPath, chunking: { tokens: 40, overlap: 10 } });
    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    // First sync
    const initialMessages = makeGrowingMessages(3);
    await fs.writeFile(sessionFilePath, makeSessionJsonl(initialMessages));
    await manager.sync({ force: true });
    const r1Chunks = countDbChunks((manager as any).db, "sessions/test-session.jsonl", "sessions");

    // Grow session
    const grownMessages = makeGrowingMessages(2, initialMessages);
    await fs.writeFile(sessionFilePath, makeSessionJsonl(grownMessages));

    // Second sync
    embedBatch.mockClear();
    await manager.sync({ sessionFiles: [sessionFilePath] });
    const r2Embeds = embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length;
    const r2Chunks = countDbChunks((manager as any).db, "sessions/test-session.jsonl", "sessions");

    // With overlap, boundary chunks may change, but embeds should still be less than total
    expect(r2Embeds).toBeLessThanOrEqual(r2Chunks);
  });

  it("multiple incremental syncs maintain efficiency", async () => {
    const cfg = createCfg({ storePath: indexPath, chunking: { tokens: 40, overlap: 0 } });
    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    const embedCounts: number[] = [];
    const chunkCounts: number[] = [];

    // Initial sync
    let allMessages = makeGrowingMessages(3);
    await fs.writeFile(sessionFilePath, makeSessionJsonl(allMessages));
    await manager.sync({ force: true });
    chunkCounts.push(countDbChunks((manager as any).db, "sessions/test-session.jsonl", "sessions"));

    // Incremental syncs
    for (let round = 1; round <= 3; round++) {
      allMessages = makeGrowingMessages(2, allMessages);
      await fs.writeFile(sessionFilePath, makeSessionJsonl(allMessages));
      embedBatch.mockClear();
      await manager.sync({ sessionFiles: [sessionFilePath] });
      embedCounts.push(embedBatch.mock.calls.flatMap((c: any) => c[0] as string[]).length);
      chunkCounts.push(
        countDbChunks((manager as any).db, "sessions/test-session.jsonl", "sessions"),
      );
    }

    // Each incremental sync should embed fewer texts than total chunks
    for (let i = 0; i < embedCounts.length; i++) {
      const newChunks = chunkCounts[i + 1] - chunkCounts[i];
      expect(embedCounts[i]).toBeLessThanOrEqual(newChunks + 1);
    }
  });
});
