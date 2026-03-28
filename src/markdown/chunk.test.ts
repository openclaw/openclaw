import { describe, expect, it } from "vitest";
import { hasBalancedFences } from "../test-utils/chunk-test-helpers.js";
import { chunkMarkdownWithBalancedFences } from "./chunk.js";

function expectChunkInvariants(chunks: string[], maxChars: number) {
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThanOrEqual(maxChars);
  }
}

describe("chunkMarkdownWithBalancedFences", () => {
  it("keeps fenced code blocks balanced across chunks", () => {
    const body = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `Here is code:\n\n\`\`\`js\n${body}\n\`\`\`\n\nDone.`;

    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(200);
    }

    expect(chunks.some((chunk) => chunk.includes("```js"))).toBe(true);
    expect(chunks.at(-1)).toContain("Done.");
  });

  it("prefers paragraph breaks before newline or whitespace", () => {
    const text = ["a".repeat(30), "b".repeat(30), "c".repeat(30)].join("\n\n");
    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 75 });

    expect(chunks).toEqual([`${"a".repeat(30)}\n\n${"b".repeat(30)}\n\n`, "c".repeat(30)]);
  });

  it("prefers newline breaks before whitespace", () => {
    const text = `alpha beta gamma\ndelta epsilon zeta`;
    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 22 });

    expect(chunks).toEqual(["alpha beta gamma\n", "delta epsilon zeta"]);
  });

  it("prefers whitespace breaks before arbitrary character splits", () => {
    const text = "alpha beta gamma delta";
    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 12 });

    expect(chunks).toEqual(["alpha beta ", "gamma delta"]);
  });

  it("falls back to arbitrary splits when no better boundary exists", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 10 });

    expect(chunks).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
  });

  it("splits oversized fenced blocks while keeping each chunk balanced", () => {
    const body = "a".repeat(80);
    const text = `\`\`\`txt\n${body}\n\`\`\``;

    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it("keeps making progress when a split lands inside a long fence opener", () => {
    const text = `\`\`\`verylonglanguagehint\nconsole.log("hi");\n\`\`\``;

    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(8);
    }
  });

  it("does not loop when maxChars is smaller than the fence closing budget", () => {
    const text = `\`\`\`txt\nabc\n\`\`\``;

    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 3 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3);
    }
  });

  it("keeps making progress when a carry-over would recreate the same fence prefix", () => {
    const text = `\`\`\`txt\nabcdef\n\`\`\``;

    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 11 });
    expect(chunks).toEqual(["```txt\n", "abcdef\n```"]);
  });

  it("does not add an extra newline when reopening a fenced chunk at a newline boundary", () => {
    const text = `\`\`\`txt\nabc\ndefghij\n\`\`\``;

    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 15 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(1)) {
      expect(chunk.startsWith("```txt\n\n")).toBe(false);
    }
  });

  it("closes the final chunk when an unterminated fenced block exceeds maxChars", () => {
    const text = `\`\`\`txt\n${"a".repeat(2100)}`;

    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("closes an unterminated fenced block that already fits once balanced", () => {
    const text = `\`\`\`txt\nabc`;

    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 20 });
    expect(chunks).toEqual(["```txt\nabc\n```"]);
    expect(hasBalancedFences(chunks[0])).toBe(true);
  });

  it("keeps the final balanced chunk within maxChars when closing an unterminated fence", () => {
    const text = `\`\`\`txt\n${"a".repeat(25)}\n\nrest`;

    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("closes a trailing unterminated fence that starts after a leading newline split", () => {
    const text = `${"a".repeat(11)}\n\`\`\`txt\nabc`;

    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 11 });
    expect(chunks[0]).toBe("a".repeat(11));
    for (const chunk of chunks.slice(1)) {
      expect(chunk.length).toBeLessThanOrEqual(11);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("preserves whitespace when splitting long lines", () => {
    const text = Array.from({ length: 40 }, () => "word").join(" ");
    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("preserves mixed whitespace across chunk boundaries", () => {
    const text = "alpha  beta\tgamma   delta epsilon  zeta";
    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 12 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps leading whitespace when splitting long lines", () => {
    const text = "    indented line with words that force splits";
    const chunks = chunkMarkdownWithBalancedFences(text, { maxChars: 14 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps making bounded progress across representative hostile inputs", () => {
    const cases = [
      "abcdefghijklmnopqrstuvwxyz",
      "    indented line with words that force splits",
      "alpha  beta\tgamma   delta epsilon  zeta",
      "```txt\nabcdef\n```",
      "```txt\n01234567890123456789\n```",
      "```verylonglanguagehint\n01234567890123456789\n```",
      "```txt\nabc",
      "aaaaaaaaaaa\n```txt\nabc",
    ];

    for (const text of cases) {
      for (let maxChars = 1; maxChars <= 20; maxChars++) {
        const chunks = chunkMarkdownWithBalancedFences(text, { maxChars });
        expectChunkInvariants(chunks, maxChars);
      }
    }
  });

  it("does not drop numeric payload bytes across fence reopen adjustments", () => {
    const text = "```verylonglanguagehint\n01234567890123456789\n```";

    for (let maxChars = 1; maxChars <= 25; maxChars++) {
      const chunks = chunkMarkdownWithBalancedFences(text, { maxChars });
      expectChunkInvariants(chunks, maxChars);
      expect(chunks.join("").replace(/\D/g, "")).toBe("01234567890123456789");
    }
  });
});
