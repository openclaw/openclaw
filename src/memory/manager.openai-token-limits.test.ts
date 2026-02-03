import { countTokens, encode } from "gpt-tokenizer/encoding/cl100k_base";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0]));
const embedQuery = vi.fn(async () => [0, 1, 0]);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery,
      embedBatch,
    },
  }),
}));

describe("memory openai embedding token limits", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    embedBatch.mockClear();
    embedQuery.mockClear();
    embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [0, 1, 0]));
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-oai-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  const makeCfg = (workspaceDir: string, indexPath: string, chunkTokens = 200) => ({
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "text-embedding-3-small",
          store: { path: indexPath },
          chunking: { tokens: chunkTokens, overlap: 0 },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0 },
        },
      },
      list: [{ id: "main", default: true }],
    },
  });

  it("splits chunks exceeding 8192 openai token limit", async () => {
    // "hello " ≈ 1 cl100k token; 9000 repetitions > 8192 token limit.
    const content = "hello ".repeat(9000);
    const tokens = countTokens(content);
    expect(tokens).toBeGreaterThan(8192);

    await fs.writeFile(path.join(workspaceDir, "memory", "2026-02-02.md"), content);

    // Large chunk size so the markdown chunker keeps it as one chunk
    const cfg = makeCfg(workspaceDir, indexPath, 16000);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    manager = result.manager!;
    await manager.sync({ force: true });

    // splitChunksForEmbeddingLimit should split the oversized chunk
    const allTexts = embedBatch.mock.calls.flatMap((c) => c[0] ?? []);
    expect(allTexts.length).toBeGreaterThan(1);

    // Each split chunk must be within the 8192 token limit
    for (const text of allTexts) {
      expect(countTokens(text)).toBeLessThanOrEqual(8192);
    }
  });

  it("respects 8192 token cap when building openai batches", async () => {
    // Create a single file with markdown sections that produce multiple chunks.
    // Each section ≈ 5000 cl100k tokens → two chunks can't share a batch.
    const sectionBody = "token ".repeat(5000);
    const sectionTokens = countTokens(sectionBody);
    expect(sectionTokens).toBeGreaterThan(4000);
    expect(sectionTokens).toBeLessThan(8192);

    const content = [
      "# Section A",
      sectionBody,
      "# Section B",
      sectionBody,
      "# Section C",
      sectionBody,
    ].join("\n");

    await fs.writeFile(path.join(workspaceDir, "memory", "2026-02-03.md"), content);

    // Chunk size large enough to keep each section intact
    const cfg = makeCfg(workspaceDir, indexPath, 8000);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    manager = result.manager!;
    await manager.sync({ force: true });

    // With 3 chunks of ~5000 tokens, two chunks alone exceed 8192 → need 2+ batches
    expect(embedBatch.mock.calls.length).toBeGreaterThan(1);

    // Verify each batch stays within limits
    for (const call of embedBatch.mock.calls) {
      const texts = call[0];
      const batchTokens = texts.reduce((sum, t) => sum + countTokens(t), 0);
      expect(batchTokens).toBeLessThanOrEqual(8192 + texts.length);
    }
  });

  it("does not split chunks under 8192 tokens", async () => {
    // Create content that fits exactly within the limit
    const perWord = encode("test ").length;
    const repetitions = Math.floor(8192 / perWord);
    const content = "test ".repeat(repetitions);
    expect(countTokens(content)).toBeLessThanOrEqual(8192);

    await fs.writeFile(path.join(workspaceDir, "memory", "2026-02-06.md"), content);

    const cfg = makeCfg(workspaceDir, indexPath, 16000);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    manager = result.manager!;
    await manager.sync({ force: true });

    // Should remain as a single chunk — no splitting needed
    const allTexts = embedBatch.mock.calls.flatMap((c) => c[0] ?? []);
    expect(allTexts.length).toBe(1);
  });

  it("uses cl100k_base counting to produce more batches than char approximation would", async () => {
    // Single-char words have ~2x more cl100k tokens than chars/4 estimates.
    // "a b c d " = 8 chars → chars/4 = 2 tokens. cl100k: "a"," b"," c"," d"," " ≈ 5 tokens.
    // This divergence means cl100k-aware batching creates more batches.
    const singleCharWords = "a b c d e f g h i j k l m n o p q r s t u v w x y z ";
    const section = singleCharWords.repeat(200); // ~200*26 ≈ 5200 cl100k tokens
    const charEstimate = Math.ceil(section.length / 4);
    const realTokens = countTokens(section);

    // cl100k should report significantly more tokens than chars/4
    expect(realTokens).toBeGreaterThan(charEstimate * 1.5);

    const content = ["# Part 1", section, "# Part 2", section].join("\n");

    await fs.writeFile(path.join(workspaceDir, "memory", "2026-02-07.md"), content);

    // Chunk size large enough so each section stays as one chunk
    const cfg = makeCfg(workspaceDir, indexPath, 8000);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    manager = result.manager!;
    await manager.sync({ force: true });

    // With cl100k counting, 2 chunks of ~5200 tokens each exceed 8192 → 2 batches.
    // With chars/4, ~2600 + ~2600 = ~5200 < 8192 → would have been 1 batch.
    expect(embedBatch.mock.calls.length).toBe(2);
  });
});
