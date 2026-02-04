import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateMemoryIndex, writeMemoryIndex } from "./progressive-index.js";
import { ProgressiveMemoryStore } from "./progressive-store.js";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prog-index-test-"));
  return path.join(dir, "progressive.db");
}

describe("Progressive Memory Index", () => {
  let store: ProgressiveMemoryStore;
  let dbPath: string;
  let tmpDir: string;

  function createStore() {
    dbPath = tmpDbPath();
    tmpDir = path.dirname(dbPath);
    store = new ProgressiveMemoryStore({ dbPath, dims: 3 });
    return store;
  }

  afterEach(() => {
    store?.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("generates empty index for empty store", () => {
    createStore();
    const index = generateMemoryIndex(store);
    expect(index).toContain("# Memory Index");
    expect(index).toContain("memory_recall");
  });

  it("includes critical entries with full text", async () => {
    createStore();
    await store.store({
      category: "instruction",
      content: "Never send messages without asking first",
      priority: "critical",
    });

    const index = generateMemoryIndex(store);
    expect(index).toContain("Critical (always relevant)");
    expect(index).toContain("Never send messages without asking first");
  });

  it("includes high-priority entries as summaries", async () => {
    createStore();
    await store.store({
      category: "preference",
      content: "Tone: efficient but conversational; has personality",
      priority: "high",
    });

    const index = generateMemoryIndex(store);
    expect(index).toContain("Preferences");
    expect(index).toContain("efficient but conversational");
  });

  it("includes domain summary section", async () => {
    createStore();
    await store.store({ category: "fact", content: "Fact 1" });
    await store.store({ category: "fact", content: "Fact 2" });
    await store.store({ category: "preference", content: "Pref 1" });

    const index = generateMemoryIndex(store);
    expect(index).toContain("Domains");
    expect(index).toContain("fact");
    expect(index).toContain("preference");
    expect(index).toContain("memory_recall");
  });

  it("stays within token budget", async () => {
    createStore();
    // Add many entries to test budget enforcement
    for (let i = 0; i < 50; i++) {
      await store.store({
        category: "fact",
        content: `This is fact number ${i} with some extra text to fill it up. `.repeat(3),
        priority: i < 5 ? "critical" : "high",
      });
    }

    const index = generateMemoryIndex(store, { maxTokens: 1500 });
    const tokenEstimate = Math.ceil(index.length / 4);
    // Allow some overflow since we don't cut mid-line
    expect(tokenEstimate).toBeLessThan(2000);
  });

  it("writes index to file", async () => {
    createStore();
    await store.store({
      category: "person",
      content: "David — America/Denver",
      priority: "critical",
    });

    const outputPath = path.join(tmpDir, "MEMORY-INDEX.md");
    const result = await writeMemoryIndex(store, outputPath);

    expect(result.path).toBe(outputPath);
    expect(result.tokenEstimate).toBeGreaterThan(0);
    expect(fs.existsSync(outputPath)).toBe(true);

    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toContain("# Memory Index");
    expect(content).toContain("David");
  });

  it("compresses markdown content", async () => {
    createStore();
    await store.store({
      category: "instruction",
      content: "**Always** use `memory_recall` for [domain queries](link). ```code block```",
      priority: "critical",
    });

    const index = generateMemoryIndex(store);
    // Should strip markdown formatting
    expect(index).toContain("Always");
    expect(index).not.toContain("**");
    expect(index).not.toContain("```");
  });
});
