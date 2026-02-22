import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeHybridResults } from "./hybrid.js";
import {
  applyTemporalDecayToHybridResults,
  applyTemporalDecayToScore,
  calculateTemporalDecayMultiplier,
  isImportantChunk,
  type ImportanceBoostConfig,
} from "./temporal-decay.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 1, 10, 0, 0, 0);

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-temporal-decay-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("temporal decay", () => {
  it("matches exponential decay formula", () => {
    const halfLifeDays = 30;
    const ageInDays = 10;
    const lambda = Math.LN2 / halfLifeDays;
    const expectedMultiplier = Math.exp(-lambda * ageInDays);

    expect(calculateTemporalDecayMultiplier({ ageInDays, halfLifeDays })).toBeCloseTo(
      expectedMultiplier,
    );
    expect(applyTemporalDecayToScore({ score: 0.8, ageInDays, halfLifeDays })).toBeCloseTo(
      0.8 * expectedMultiplier,
    );
  });

  it("is 0.5 exactly at half-life", () => {
    expect(calculateTemporalDecayMultiplier({ ageInDays: 30, halfLifeDays: 30 })).toBeCloseTo(0.5);
  });

  it("does not decay evergreen memory files", async () => {
    const dir = await makeTempDir();

    const rootMemoryPath = path.join(dir, "MEMORY.md");
    const topicPath = path.join(dir, "memory", "projects.md");
    await fs.mkdir(path.dirname(topicPath), { recursive: true });
    await fs.writeFile(rootMemoryPath, "evergreen");
    await fs.writeFile(topicPath, "topic evergreen");

    const veryOld = new Date(Date.UTC(2010, 0, 1));
    await fs.utimes(rootMemoryPath, veryOld, veryOld);
    await fs.utimes(topicPath, veryOld, veryOld);

    const decayed = await applyTemporalDecayToHybridResults({
      results: [
        { path: "MEMORY.md", score: 1, source: "memory" },
        { path: "memory/projects.md", score: 0.75, source: "memory" },
      ],
      workspaceDir: dir,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
    });

    expect(decayed[0]?.score).toBeCloseTo(1);
    expect(decayed[1]?.score).toBeCloseTo(0.75);
  });

  it("applies decay in hybrid merging before ranking", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 0,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      mmr: { enabled: false },
      nowMs: NOW_MS,
      vector: [
        {
          id: "old",
          path: "memory/2025-01-01.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "old but high",
          vectorScore: 0.95,
        },
        {
          id: "new",
          path: "memory/2026-02-10.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "new and relevant",
          vectorScore: 0.8,
        },
      ],
      keyword: [],
    });

    expect(merged[0]?.path).toBe("memory/2026-02-10.md");
    expect(merged[0]?.score ?? 0).toBeGreaterThan(merged[1]?.score ?? 0);
  });

  it("handles future dates, zero age, and very old memories", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 0,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      mmr: { enabled: false },
      nowMs: NOW_MS,
      vector: [
        {
          id: "future",
          path: "memory/2099-01-01.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "future",
          vectorScore: 0.9,
        },
        {
          id: "today",
          path: "memory/2026-02-10.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "today",
          vectorScore: 0.8,
        },
        {
          id: "very-old",
          path: "memory/2000-01-01.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "ancient",
          vectorScore: 1,
        },
      ],
      keyword: [],
    });

    const byPath = new Map(merged.map((entry) => [entry.path, entry]));
    expect(byPath.get("memory/2099-01-01.md")?.score).toBeCloseTo(0.9);
    expect(byPath.get("memory/2026-02-10.md")?.score).toBeCloseTo(0.8);
    expect(byPath.get("memory/2000-01-01.md")?.score ?? 1).toBeLessThan(0.001);
  });

  it("uses file mtime fallback for non-memory sources", async () => {
    const dir = await makeTempDir();
    const sessionPath = path.join(dir, "sessions", "thread.jsonl");
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, "{}\n");
    const oldMtime = new Date(NOW_MS - 30 * DAY_MS);
    await fs.utimes(sessionPath, oldMtime, oldMtime);

    const decayed = await applyTemporalDecayToHybridResults({
      results: [{ path: "sessions/thread.jsonl", score: 1, source: "sessions" }],
      workspaceDir: dir,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
    });

    expect(decayed[0]?.score).toBeCloseTo(0.5, 2);
  });
});

describe("importance-weighted decay", () => {
  const enabledConfig: ImportanceBoostConfig = {
    enabled: true,
    boostFactor: 3,
    patterns: {
      contentMarkers: ["<!-- important -->", "**IMPORTANT**", "[!important]"],
      filePatterns: ["MEMORY.md"],
    },
  };

  describe("isImportantChunk", () => {
    it("matches file patterns case-insensitively", () => {
      expect(isImportantChunk({ filePath: "MEMORY.md", config: enabledConfig })).toBe(true);
      expect(isImportantChunk({ filePath: "memory.md", config: enabledConfig })).toBe(true);
      expect(isImportantChunk({ filePath: "foo/MEMORY.md", config: enabledConfig })).toBe(true);
    });

    it("matches content markers", () => {
      expect(
        isImportantChunk({
          filePath: "memory/2025-01-01.md",
          snippet: "some text <!-- important --> more text",
          config: enabledConfig,
        }),
      ).toBe(true);
      expect(
        isImportantChunk({
          filePath: "memory/2025-01-01.md",
          snippet: "**IMPORTANT** note",
          config: enabledConfig,
        }),
      ).toBe(true);
      expect(
        isImportantChunk({
          filePath: "memory/2025-01-01.md",
          snippet: "has [!important] callout",
          config: enabledConfig,
        }),
      ).toBe(true);
    });

    it("returns false when no patterns match", () => {
      expect(
        isImportantChunk({
          filePath: "memory/2025-01-01.md",
          snippet: "just normal text",
          config: enabledConfig,
        }),
      ).toBe(false);
    });

    it("returns false when disabled", () => {
      expect(
        isImportantChunk({
          filePath: "MEMORY.md",
          config: { ...enabledConfig, enabled: false },
        }),
      ).toBe(false);
    });
  });

  it("important memories decay slower than normal ones", async () => {
    const results = await applyTemporalDecayToHybridResults({
      results: [
        {
          path: "memory/2025-11-10.md",
          score: 0.8,
          source: "memory",
          snippet: "normal memory",
        },
        {
          path: "memory/2025-11-10.md",
          score: 0.8,
          source: "memory",
          snippet: "<!-- important --> key memory",
        },
      ],
      temporalDecay: {
        enabled: true,
        halfLifeDays: 30,
        importanceBoost: { enabled: true, boostFactor: 3 },
      },
      nowMs: NOW_MS,
    });

    // Both started at 0.8, ~92 days old
    // Normal decays with full age, important with age/3
    expect(results[1].score).toBeGreaterThan(results[0].score);
  });

  it("boost is disabled by default (backwards-compatible)", async () => {
    const results = await applyTemporalDecayToHybridResults({
      results: [
        {
          path: "memory/2025-11-10.md",
          score: 0.8,
          source: "memory",
          snippet: "<!-- important --> key memory",
        },
        {
          path: "memory/2025-11-10.md",
          score: 0.8,
          source: "memory",
          snippet: "normal memory",
        },
      ],
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
    });

    // Without importance boost, both should decay identically
    expect(results[0].score).toBeCloseTo(results[1].score);
  });

  it("boostFactor of 1 has no effect", async () => {
    const results = await applyTemporalDecayToHybridResults({
      results: [
        {
          path: "memory/2025-11-10.md",
          score: 0.8,
          source: "memory",
          snippet: "<!-- important --> key memory",
        },
        {
          path: "memory/2025-11-10.md",
          score: 0.8,
          source: "memory",
          snippet: "normal memory",
        },
      ],
      temporalDecay: {
        enabled: true,
        halfLifeDays: 30,
        importanceBoost: { enabled: true, boostFactor: 1 },
      },
      nowMs: NOW_MS,
    });

    expect(results[0].score).toBeCloseTo(results[1].score);
  });

  it("integrates with hybrid merge via file pattern matching", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 0,
      temporalDecay: {
        enabled: true,
        halfLifeDays: 30,
        importanceBoost: { enabled: true, boostFactor: 3 },
      },
      mmr: { enabled: false },
      nowMs: NOW_MS,
      vector: [
        {
          id: "old-normal",
          path: "memory/2025-11-10.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "old normal memory",
          vectorScore: 0.9,
        },
        {
          id: "old-important",
          path: "memory/2025-11-10.md",
          startLine: 10,
          endLine: 15,
          source: "memory",
          snippet: "old but <!-- important --> memory",
          vectorScore: 0.9,
        },
      ],
      keyword: [],
    });

    // Important one should rank higher despite same age and vector score
    const importantEntry = merged.find((e) => e.snippet.includes("important"));
    const normalEntry = merged.find((e) => !e.snippet.includes("important"));
    expect(importantEntry!.score).toBeGreaterThan(normalEntry!.score);
  });
});
