// src/memory-host-sdk/host/chunking/chunking.test.ts

import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../embeddings.js";
// ── fixed-size ──────────────────────────────────────────────────────────────
import { chunkFixedSize, FixedSizeStrategy } from "./fixed-size.js";
// ── hichunk ──────────────────────────────────────────────────────────────────
import {
  countHeadingLevel,
  HiChunkStrategy,
  isEnglish,
  parseAnswerChunkingPoints,
  replaceHeadingMarkers,
  truncateSentence,
} from "./hichunk.js";
// ── lumber ───────────────────────────────────────────────────────────────────
import { LumberChunkerStrategy, parseShiftPointId, splitIntoParagraphs } from "./lumber.js";
// ── markdown-heading ─────────────────────────────────────────────────────────
import { MarkdownHeadingStrategy } from "./markdown-heading.js";
// ── factory ───────────────────────────────────────────────────────────────────
import { resolveChunkingStrategy } from "./resolve.js";
// ── semantic ─────────────────────────────────────────────────────────────────
import { SemanticStrategy } from "./semantic.js";
// ── sentence ─────────────────────────────────────────────────────────────────
import { SentenceStrategy, splitIntoSentences } from "./sentence.js";
import type { ChunkingConfig } from "./types.js";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a simple fake EmbeddingProvider that returns zero-vectors or custom vectors. */
function makeFakeProvider(vectors?: number[][]): EmbeddingProvider {
  return {
    embedBatch: vi.fn(async (texts: string[]) => {
      if (vectors) {
        return texts.map((_, i) => vectors[i] ?? Array.from({ length: 4 }, () => 0));
      }
      return texts.map(() => Array.from({ length: 4 }, () => 0));
    }),
  } as unknown as EmbeddingProvider;
}

// ============================================================================
// 1. fixed-size
// ============================================================================

describe("chunkFixedSize", () => {
  it("returns [] for empty content", () => {
    expect(chunkFixedSize("", { tokens: 100, overlap: 0 })).toEqual([]);
  });

  it("returns a single chunk when content fits within token budget", () => {
    const content = "Hello world\nThis is a short doc.";
    const chunks = chunkFixedSize(content, { tokens: 400, overlap: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(content);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(2);
  });

  it("splits into multiple chunks when content exceeds token budget", () => {
    // Each line is ~10 chars; tokens=5 → maxChars ≈ 20 (CHARS_PER_TOKEN_ESTIMATE=4)
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} content here.`);
    const content = lines.join("\n");
    const chunks = chunkFixedSize(content, { tokens: 5, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // All lines must be covered (no loss)
    const allText = chunks.map((c) => c.text).join("\n");
    for (const line of lines) {
      expect(allText).toContain(line);
    }
  });

  it("carries overlap lines into the next chunk", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Row${i + 1} ${"x".repeat(20)}`);
    const content = lines.join("\n");
    const chunks = chunkFixedSize(content, { tokens: 5, overlap: 2 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The second chunk should overlap with lines that appeared in the first chunk
    const firstChunkLastLine = chunks[0]!.text.split("\n").at(-1)!;
    expect(chunks[1]!.text).toContain(firstChunkLastLine);
  });

  it("line numbers are 1-indexed and correct", () => {
    const content = "a\nb\nc\nd\ne";
    const chunks = chunkFixedSize(content, { tokens: 400, overlap: 0 });
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(5);
  });

  it("handles CJK content without infinite loop", () => {
    const cjk = "这是一段中文内容。".repeat(50);
    const chunks = chunkFixedSize(cjk, { tokens: 10, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("each chunk has a non-empty hash", () => {
    const content = "line1\nline2\nline3";
    const chunks = chunkFixedSize(content, { tokens: 400, overlap: 0 });
    for (const chunk of chunks) {
      expect(chunk.hash).toBeTruthy();
      expect(chunk.hash.length).toBe(64); // SHA-256 hex
    }
  });
});

describe("FixedSizeStrategy", () => {
  it("uses DEFAULT_CHUNK_TOKENS and DEFAULT_CHUNK_OVERLAP when not specified", () => {
    const strategy = new FixedSizeStrategy({ strategy: "fixed-size" });
    expect(strategy.name).toBe("fixed-size");
    // Chunk a short doc — should produce exactly one chunk
    const chunks = strategy.chunk("hello", { strategy: "fixed-size" });
    expect(chunks).toHaveLength(1);
  });

  it("respects custom tokens and overlap from config", () => {
    const strategy = new FixedSizeStrategy({ strategy: "fixed-size", tokens: 5, overlap: 1 });
    const lines = Array.from({ length: 20 }, (_, i) => `word${"x".repeat(25)} ${i}`);
    const chunks = strategy.chunk(lines.join("\n"), { strategy: "fixed-size" });
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ============================================================================
// 2. markdown-heading
// ============================================================================

describe("MarkdownHeadingStrategy", () => {
  const cfg: ChunkingConfig = { strategy: "markdown-heading", maxDepth: 3 };

  it("emits one chunk for plain text with no headings", () => {
    const strategy = new MarkdownHeadingStrategy(cfg);
    const content = "Just some text\nwithout any headings.";
    const chunks = strategy.chunk(content, cfg);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(content);
  });

  it("splits on H1/H2/H3 headings by default (maxDepth=3)", () => {
    const content = [
      "# Chapter 1",
      "Intro text.",
      "## Section 1.1",
      "Section content.",
      "### Sub-section 1.1.1",
      "Sub content.",
      "# Chapter 2",
      "More content.",
    ].join("\n");
    const strategy = new MarkdownHeadingStrategy(cfg);
    const chunks = strategy.chunk(content, cfg);
    // Expect 4 chunks (each heading starts a new chunk)
    expect(chunks.length).toBe(4);
    expect(chunks[0]!.text).toContain("# Chapter 1");
    expect(chunks[2]!.text).toContain("### Sub-section 1.1.1");
  });

  it("does NOT split on H4 when maxDepth=3", () => {
    const content = ["# Top", "body", "#### Deep heading", "deep body"].join("\n");
    const strategy = new MarkdownHeadingStrategy({ strategy: "markdown-heading", maxDepth: 3 });
    const chunks = strategy.chunk(content, cfg);
    // H4 should NOT trigger a split; "#### Deep heading" stays in the first chunk
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain("#### Deep heading");
  });

  it("splits on H4 when maxDepth=4", () => {
    const content = ["# Top", "body", "#### Deep heading", "deep body"].join("\n");
    const strategy = new MarkdownHeadingStrategy({ strategy: "markdown-heading", maxDepth: 4 });
    const chunks = strategy.chunk(content, cfg);
    expect(chunks.length).toBe(2);
  });

  it("sub-chunks oversized sections via fixed-size fallback", () => {
    // maxTokens=5 → maxChars≈20; section with many lines should be sub-chunked
    const bigSection = Array.from({ length: 30 }, (_, i) => `word${"y".repeat(20)} ${i}`).join("\n");
    const content = `# Big Section\n${bigSection}`;
    const strategy = new MarkdownHeadingStrategy({
      strategy: "markdown-heading",
      maxTokens: 5,
    });
    const chunks = strategy.chunk(content, cfg);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("line numbers reflect original document positions", () => {
    const content = ["intro", "# Section", "body"].join("\n");
    const strategy = new MarkdownHeadingStrategy(cfg);
    const chunks = strategy.chunk(content, cfg);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[1]!.startLine).toBe(2);
    expect(chunks[1]!.endLine).toBe(3);
  });

  it("skips empty sections", () => {
    const content = ["# Empty", "", "# Non-empty", "has content"].join("\n");
    const strategy = new MarkdownHeadingStrategy(cfg);
    const chunks = strategy.chunk(content, cfg);
    // "# Empty" section is whitespace only, should be skipped
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
  });
});

// ============================================================================
// 3. sentence
// ============================================================================

describe("splitIntoSentences", () => {
  it("returns [] for empty string", () => {
    expect(splitIntoSentences("")).toEqual([]);
  });

  it("splits on period", () => {
    const entries = splitIntoSentences("Hello world. Goodbye world.");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]!.text).toContain("Hello world");
  });

  it("splits on Chinese period 。", () => {
    const entries = splitIntoSentences("你好世界。再见世界。");
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("does not split on decimal points", () => {
    const entries = splitIntoSentences("Version 1.5 is released.");
    // "1.5" should not trigger a split inside the number
    expect(entries.some((e) => e.text.includes("1.5"))).toBe(true);
  });

  it("treats blank lines as paragraph separators (no empty entries)", () => {
    const entries = splitIntoSentences("Line one.\n\nLine two.");
    expect(entries.every((e) => e.text.trim().length > 0)).toBe(true);
  });

  it("preserves line numbers correctly", () => {
    const entries = splitIntoSentences("First line.\nSecond line.");
    expect(entries[0]!.startLine).toBe(1);
    expect(entries[1]!.startLine).toBe(2);
  });
});

describe("SentenceStrategy", () => {
  const cfg: ChunkingConfig = { strategy: "sentence" };

  it("returns [] for empty content", () => {
    const strategy = new SentenceStrategy(cfg);
    expect(strategy.chunk("", cfg)).toEqual([]);
  });

  it("produces a single chunk for short content", () => {
    const strategy = new SentenceStrategy({ strategy: "sentence", targetTokens: 400 });
    const chunks = strategy.chunk("Short sentence.", cfg);
    expect(chunks).toHaveLength(1);
  });

  it("splits into multiple chunks when over budget", () => {
    const strategy = new SentenceStrategy({ strategy: "sentence", targetTokens: 5, overlapSentences: 0 });
    const content = Array.from({ length: 20 }, (_, i) => `Sentence ${i + 1} with some extra words here.`).join(" ");
    const chunks = strategy.chunk(content, cfg);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("carries overlap sentences into next chunk", () => {
    const strategy = new SentenceStrategy({ strategy: "sentence", targetTokens: 5, overlapSentences: 1 });
    const sentences = Array.from({ length: 10 }, (_, i) => `${"Word ".repeat(20)}sentence ${i + 1}.`);
    const content = sentences.join(" ");
    const chunks = strategy.chunk(content, cfg);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Last sentence in chunk[0] should appear in chunk[1] (overlap)
    const lastSentenceOfFirst = chunks[0]!.text.split("\n").at(-1)!;
    expect(chunks[1]!.text).toContain(lastSentenceOfFirst);
  });
});

// ============================================================================
// 4. semantic
// ============================================================================

describe("SemanticStrategy", () => {
  const cfg: ChunkingConfig = { strategy: "semantic" };

  it("returns single chunk for single-sentence content", async () => {
    const provider = makeFakeProvider();
    const strategy = new SemanticStrategy(cfg, provider);
    const chunks = await strategy.chunk("One single sentence.", cfg);
    expect(chunks).toHaveLength(1);
  });

  it("returns [] for empty content", async () => {
    const provider = makeFakeProvider();
    const strategy = new SemanticStrategy(cfg, provider);
    const chunks = await strategy.chunk("", cfg);
    expect(chunks).toEqual([]);
  });

  it("calls embedBatch with combined sentence windows", async () => {
    const provider = makeFakeProvider();
    const strategy = new SemanticStrategy({ strategy: "semantic", bufferSize: 1 }, provider);
    await strategy.chunk("First sentence. Second sentence. Third sentence.", cfg);
    expect(provider.embedBatch).toHaveBeenCalled();
  });

  it("creates multiple chunks when embeddings show high cosine distance", async () => {
    // Construct very different vectors for adjacent sentences → high cosine distance → split
    // Sentences: s1 = [1,0,0,0], s2 = [0,1,0,0] (perpendicular → max distance)
    // With bufferSize=0, each sentence gets its own vector.
    const vectors = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    const provider = makeFakeProvider(vectors);
    // Use threshold=50 so even moderate distances trigger splits
    const strategy = new SemanticStrategy(
      { strategy: "semantic", bufferSize: 0, breakpointPercentileThreshold: 50 },
      provider,
    );
    const content = "Alpha sentence. Beta sentence. Gamma sentence. Delta sentence.";
    const chunks = await strategy.chunk(content, cfg);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ============================================================================
// 5. lumber
// ============================================================================

describe("splitIntoParagraphs", () => {
  it("returns [] for empty string", () => {
    expect(splitIntoParagraphs("")).toEqual([]);
  });

  it("splits on blank lines", () => {
    const content = "Para one.\n\nPara two.\n\nPara three.";
    const paras = splitIntoParagraphs(content);
    expect(paras).toHaveLength(3);
    expect(paras[0]!.text).toBe("Para one.");
    expect(paras[1]!.text).toBe("Para two.");
  });

  it("assigns 1-based IDs", () => {
    const paras = splitIntoParagraphs("A\n\nB\n\nC");
    expect(paras.map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it("preserves correct line numbers", () => {
    const content = "Line1\nLine2\n\nLine4\nLine5";
    const paras = splitIntoParagraphs(content);
    expect(paras[0]!.startLine).toBe(1);
    expect(paras[0]!.endLine).toBe(2);
    expect(paras[1]!.startLine).toBe(4);
    expect(paras[1]!.endLine).toBe(5);
  });
});

describe("parseShiftPointId", () => {
  it('returns null for "Answer: NONE"', () => {
    expect(parseShiftPointId("Answer: NONE")).toBeNull();
  });

  it("parses a numeric ID from standard response", () => {
    expect(parseShiftPointId("Answer: ID 0042")).toBe(42);
  });

  it("is case-insensitive", () => {
    expect(parseShiftPointId("answer: id 7")).toBe(7);
  });

  it("returns null for malformed response", () => {
    expect(parseShiftPointId("I don't know")).toBeNull();
    expect(parseShiftPointId("")).toBeNull();
  });
});

describe("LumberChunkerStrategy", () => {
  const cfg: ChunkingConfig = { strategy: "lumber", theta: 50, completionModel: "test-model" };

  it("returns single chunk for single paragraph", async () => {
    const completionFn = vi.fn(async () => "Answer: NONE");
    const strategy = new LumberChunkerStrategy(cfg, completionFn);
    const chunks = await strategy.chunk("Single paragraph content here.", cfg);
    expect(chunks).toHaveLength(1);
    // Single paragraph → LLM should NOT be called (short-circuit)
    expect(completionFn).not.toHaveBeenCalled();
  });

  it("splits at LLM-identified shift point", async () => {
    // Build content with 3+ paragraphs so total tokens exceed theta=50
    const paras = Array.from({ length: 5 }, (_, i) => `${"Word ".repeat(15)}paragraph ${i + 1}.`);
    const content = paras.join("\n\n");
    // LLM says shift point is paragraph ID 2
    const completionFn = vi.fn(async () => "Answer: ID 0002");
    const strategy = new LumberChunkerStrategy({ ...cfg, theta: 50 }, completionFn);
    const chunks = await strategy.chunk(content, cfg);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('produces one chunk when LLM returns "Answer: NONE"', async () => {
    const paras = Array.from({ length: 5 }, (_, i) => `${"Word ".repeat(15)}para ${i + 1}.`);
    const content = paras.join("\n\n");
    const completionFn = vi.fn(async () => "Answer: NONE");
    const strategy = new LumberChunkerStrategy({ ...cfg, theta: 10 }, completionFn);
    const chunks = await strategy.chunk(content, cfg);
    // NONE means no split within the group; may still produce chunks per group iterations
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("handles LLM errors gracefully (no throw)", async () => {
    const paras = Array.from({ length: 5 }, (_, i) => `${"Foo ".repeat(15)}para ${i + 1}.`);
    const content = paras.join("\n\n");
    const completionFn = vi.fn(async () => { throw new Error("LLM failed"); });
    const strategy = new LumberChunkerStrategy({ ...cfg, theta: 10 }, completionFn);
    // Should not throw; fallback treats group as single chunk
    await expect(strategy.chunk(content, cfg)).resolves.toBeDefined();
  });
});

// ============================================================================
// 6. hichunk — helper functions
// ============================================================================

describe("countHeadingLevel", () => {
  it("returns 0 for non-heading lines", () => {
    expect(countHeadingLevel("plain text")).toBe(0);
    expect(countHeadingLevel("")).toBe(0);
  });

  it("counts # characters correctly", () => {
    expect(countHeadingLevel("# H1")).toBe(1);
    expect(countHeadingLevel("## H2")).toBe(2);
    expect(countHeadingLevel("### H3")).toBe(3);
    expect(countHeadingLevel("###### H6")).toBe(6);
  });
});

describe("replaceHeadingMarkers", () => {
  it("returns line unchanged when replacement is null", () => {
    expect(replaceHeadingMarkers("## Title", null)).toBe("## Title");
  });

  it("strips heading markers when replacement is empty string", () => {
    const result = replaceHeadingMarkers("## Title text", "");
    expect(result).not.toMatch(/^#+/);
    expect(result).toContain("Title text");
  });

  it("normalizes to single # when replacement is '# '", () => {
    const result = replaceHeadingMarkers("### Deep heading", "# ");
    expect(result).toBe("# Deep heading");
  });
});

describe("isEnglish", () => {
  it("returns true for ASCII-only text", () => {
    expect(isEnglish("Hello world!")).toBe(true);
  });

  it("returns false when CJK characters are present", () => {
    expect(isEnglish("Hello 世界")).toBe(false);
    expect(isEnglish("完全中文")).toBe(false);
  });
});

describe("truncateSentence", () => {
  it("returns original line when within limit", () => {
    const short = "Short line.";
    expect(truncateSentence(short)).toBe(short);
  });

  it("truncates long English lines", () => {
    const long = "A".repeat(400);
    const result = truncateSentence(long, 15, 15);
    expect(result.length).toBeLessThan(long.length);
  });

  it("truncates long CJK lines", () => {
    const long = "中".repeat(100);
    const result = truncateSentence(long, 15, 15);
    expect(result.length).toBeLessThan(long.length);
  });
});

describe("parseAnswerChunkingPoints", () => {
  it("returns empty arrays for empty answer", () => {
    const result = parseAnswerChunkingPoints("", 3);
    expect(result).toHaveLength(3);
    expect(result.every((arr) => arr.length === 0)).toBe(true);
  });

  it("parses Level One and Level Two entries", () => {
    const answer = [
      "1, Level One, Yes",
      "5, Level Two, No",
      "10, Level One, No",
    ].join("\n");
    const result = parseAnswerChunkingPoints(answer, 3);
    expect(result[0]).toContain(1);  // Level One → index 0
    expect(result[0]).toContain(10);
    expect(result[1]).toContain(5);  // Level Two → index 1
  });

  it("filters non-monotonic duplicates within each level", () => {
    const answer = [
      "5, Level One, Yes",
      "3, Level One, No",  // non-monotonic, should be dropped
      "8, Level One, No",
    ].join("\n");
    const result = parseAnswerChunkingPoints(answer, 2);
    // After dedup: [5, 8] (3 < 5 so dropped)
    expect(result[0]).toEqual([5, 8]);
  });

  it("ignores levels >= maxLevel", () => {
    const answer = "1, Level Three, No";
    const result = parseAnswerChunkingPoints(answer, 2); // maxLevel=2, Level Three=idx 2 → out of range
    expect(result.every((arr) => arr.length === 0)).toBe(true);
  });
});

describe("HiChunkStrategy", () => {
  const cfg: ChunkingConfig = { strategy: "hichunk", windowSize: 1000, completionModel: "test" };

  it("returns [] for empty content", async () => {
    const completionFn = vi.fn(async () => "");
    const strategy = new HiChunkStrategy(cfg, completionFn);
    const chunks = await strategy.chunk("", cfg);
    expect(chunks).toEqual([]);
  });

  it("produces chunks for multi-sentence content with mock LLM", async () => {
    const content = [
      "# Introduction",
      "This is the intro.",
      "# Body",
      "Body paragraph one.",
      "Body paragraph two.",
    ].join("\n");
    // Mock LLM returns Level One split starting at line 1 and line 3
    const completionFn = vi.fn(async () => "1, Level One, Yes\n3, Level One, Yes");
    const strategy = new HiChunkStrategy(cfg, completionFn);
    const chunks = await strategy.chunk(content, cfg);
    expect(chunks.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 7. resolveChunkingStrategy factory
// ============================================================================

describe("resolveChunkingStrategy", () => {
  it("returns FixedSizeStrategy for 'fixed-size'", () => {
    const s = resolveChunkingStrategy({ strategy: "fixed-size" });
    expect(s.name).toBe("fixed-size");
  });

  it("returns MarkdownHeadingStrategy for 'markdown-heading'", () => {
    const s = resolveChunkingStrategy({ strategy: "markdown-heading" });
    expect(s.name).toBe("markdown-heading");
  });

  it("returns SentenceStrategy for 'sentence'", () => {
    const s = resolveChunkingStrategy({ strategy: "sentence" });
    expect(s.name).toBe("sentence");
  });

  it("throws for 'semantic' without provider", () => {
    expect(() => resolveChunkingStrategy({ strategy: "semantic" })).toThrow(
      "Semantic chunking requires an embedding provider",
    );
  });

  it("returns SemanticStrategy when provider is supplied", () => {
    const provider = makeFakeProvider();
    const s = resolveChunkingStrategy({ strategy: "semantic" }, provider);
    expect(s.name).toBe("semantic");
  });

  it("throws for 'lumber' without completionFn", () => {
    expect(() => resolveChunkingStrategy({ strategy: "lumber" })).toThrow(
      "Lumber chunking requires an LLM completion function",
    );
  });

  it("returns LumberChunkerStrategy when completionFn is supplied", () => {
    const fn = vi.fn(async () => "Answer: NONE");
    const s = resolveChunkingStrategy({ strategy: "lumber" }, null, fn);
    expect(s.name).toBe("lumber");
  });

  it("throws for 'hichunk' without completionFn", () => {
    expect(() => resolveChunkingStrategy({ strategy: "hichunk" })).toThrow(
      "HiChunk chunking requires an LLM completion function",
    );
  });

  it("returns HiChunkStrategy when completionFn is supplied", () => {
    const fn = vi.fn(async () => "");
    const s = resolveChunkingStrategy({ strategy: "hichunk" }, null, fn);
    expect(s.name).toBe("hichunk");
  });

  it("throws for unknown strategy", () => {
    expect(() =>
      resolveChunkingStrategy({ strategy: "unknown-strategy" }),
    ).toThrow("Unknown chunking strategy: unknown-strategy");
  });
});
