import { describe, expect, it } from "vitest";
import { countLines, hasBalancedFences } from "../test-utils/chunk-test-helpers.js";
import { chunkDiscordText, chunkDiscordTextWithMode } from "./chunk.js";

describe("chunkDiscordText", () => {
  it("splits tall messages even when under 2000 chars", () => {
    const text = Array.from({ length: 45 }, (_, i) => `line-${i + 1}`).join("\n");
    expect(text.length).toBeLessThan(2000);

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countLines(chunk)).toBeLessThanOrEqual(20);
    }
  });

  it("keeps fenced code blocks balanced across chunks", () => {
    const body = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `Here is code:\n\n\`\`\`js\n${body}\n\`\`\`\n\nDone.`;

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 10 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }

    expect(chunks[0]).toContain("```js");
    expect(chunks.at(-1)).toContain("Done.");
  });

  it("keeps fenced blocks intact when chunkMode is newline", () => {
    const text = "```js\nconst a = 1;\nconst b = 2;\n```\nAfter";
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars: 2000,
      maxLines: 50,
      chunkMode: "newline",
    });
    expect(chunks).toEqual([text]);
  });

  it("reserves space for closing fences when chunking", () => {
    const body = "a".repeat(120);
    const text = `\`\`\`txt\n${body}\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 50, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("preserves whitespace when splitting long lines", () => {
    const text = Array.from({ length: 40 }, () => "word").join(" ");
    const chunks = chunkDiscordText(text, { maxChars: 20, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("preserves mixed whitespace across chunk boundaries", () => {
    const text = "alpha  beta\tgamma   delta epsilon  zeta";
    const chunks = chunkDiscordText(text, { maxChars: 12, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps leading whitespace when splitting long lines", () => {
    const text = "    indented line with words that force splits";
    const chunks = chunkDiscordText(text, { maxChars: 14, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps reasoning italics balanced across chunks", () => {
    const body = Array.from({ length: 25 }, (_, i) => `${i + 1}. line`).join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      // Each chunk should have balanced italics markers (even count).
      const count = (chunk.match(/_/g) || []).length;
      expect(count % 2).toBe(0);
    }

    // Ensure italics reopen on subsequent chunks
    expect(chunks[0]).toContain("_1. line");
    // Second chunk should reopen italics at the start
    expect(chunks[1].trimStart().startsWith("_")).toBe(true);
  });

  it("keeps reasoning italics balanced when chunks split by char limit", () => {
    const longLine = "This is a very long reasoning line that forces char splits.";
    const body = Array.from({ length: 5 }, () => longLine).join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxChars: 80, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const underscoreCount = (chunk.match(/_/g) || []).length;
      expect(underscoreCount % 2).toBe(0);
    }
  });

  it("reopens italics while preserving leading whitespace on following chunk", () => {
    const body = [
      "1. line",
      "2. line",
      "3. line",
      "4. line",
      "5. line",
      "6. line",
      "7. line",
      "8. line",
      "9. line",
      "10. line",
      "  11. indented line",
      "12. line",
    ].join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    const second = chunks[1];
    expect(second.startsWith("_")).toBe(true);
    expect(second).toContain("  11. indented line");
  });
});

describe("chunkDiscordText — CJK text splitting", () => {
  it("splits Chinese text at CJK punctuation instead of mid-word", () => {
    // Build a string of Chinese sentences separated by 。that exceeds the limit.
    const sentence = "我們的架構設計需要考慮到可擴展性和高可用性。";
    const text = Array.from({ length: 10 }, () => sentence).join("");
    // sentence is ~21 chars, 10 repetitions = ~210 chars
    const chunks = chunkDiscordText(text, { maxChars: 50, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    // Every chunk except possibly the last should end at a punctuation mark.
    for (let i = 0; i < chunks.length - 1; i++) {
      const lastChar = chunks[i].slice(-1);
      expect("。！？，、；：").toContain(lastChar);
    }
    // All content is preserved.
    expect(chunks.join("")).toBe(text);
  });

  it("splits Japanese text at punctuation boundaries", () => {
    const text =
      "東京は日本の首都です。大阪は商業の中心地です。京都は歴史的な都市です。名古屋は工業都市です。";
    const chunks = chunkDiscordText(text, { maxChars: 25, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(25);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("splits pure CJK text without punctuation at character boundaries", () => {
    // Pure Chinese characters without any punctuation.
    const text = "這是一段沒有任何標點符號的中文文字用來測試在沒有標點的情況下是否能正確分割";
    const chunks = chunkDiscordText(text, { maxChars: 15, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(15);
    }
    // All content is preserved — no characters lost.
    expect(chunks.join("")).toBe(text);
  });

  it("handles mixed CJK and Latin text correctly", () => {
    const text = "Hello世界！This is a test。混合文本的分割測試，包含English和中文。";
    const chunks = chunkDiscordText(text, { maxChars: 20, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("prefers CJK punctuation over arbitrary character boundary", () => {
    // Place punctuation near the middle so the split should land there
    // rather than at the hard limit.
    const text = "這是前半段的文字，這是後半段的文字需要被分割到下一個區塊";
    const chunks = chunkDiscordText(text, { maxChars: 15, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should end at or after the comma.
    expect(chunks[0]).toContain("，");
    expect(chunks.join("")).toBe(text);
  });

  it("handles Korean text splitting", () => {
    const text =
      "서울은 대한민국의 수도입니다。부산은 항구 도시입니다。인천은 국제공항이 있습니다。";
    const chunks = chunkDiscordText(text, { maxChars: 25, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(25);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("does not regress on pure Latin text splitting", () => {
    const text = Array.from({ length: 40 }, () => "word").join(" ");
    const chunks = chunkDiscordText(text, { maxChars: 20, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // Latin text should still split on whitespace and preserve all content.
    expect(chunks.join("")).toBe(text);
  });

  it("splits CJK text within Discord 2000-char boundary", () => {
    // Simulate the real-world scenario from the issue: a long Chinese response.
    const sentence =
      "我們的架構設計需要考慮到可擴展性和高可用性，同時也要確保系統的穩定性和安全性。";
    const text = Array.from({ length: 70 }, () => sentence).join("");
    expect(text.length).toBeGreaterThan(2000);

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    // Verify no content is lost.
    expect(chunks.join("")).toBe(text);
    // Verify splits happen at punctuation, not mid-word.
    for (let i = 0; i < chunks.length - 1; i++) {
      const lastChar = chunks[i].slice(-1);
      expect("。！？，、；：").toContain(lastChar);
    }
  });

  it("handles fullwidth punctuation correctly", () => {
    const text = "第一部分！第二部分？第三部分：第四部分；第五部分、第六部分";
    const chunks = chunkDiscordText(text, { maxChars: 12, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(12);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("avoids splitting at first CJK char before long ASCII token", () => {
    // A short CJK prefix followed by a long ASCII token (e.g., URL) without spaces.
    // If we split at the CJK char, we get a tiny chunk ("你").
    // We should instead hard-split the ASCII token to maintain reasonable chunk sizes.
    const url = "https://example.com/very/long/path/that/exceeds/the/limit/without/any/spaces";
    const text = `你${url}`;

    // Set maxChars such that the URL exceeds it
    const chunks = chunkDiscordText(text, { maxChars: 30, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    // The first chunk should be substantial (hard split at 30), not just "你"
    expect(chunks[0].length).toBe(30);
    expect(chunks[0]).toBe(`你${url.slice(0, 29)}`);
    expect(chunks.join("")).toBe(text);
  });

  it("avoids splitting at early CJK punctuation before long ASCII token", () => {
    // A short CJK prefix with punctuation followed by a long ASCII token (e.g., URL).
    // If we split at the punctuation, we get a tiny chunk ("链接：").
    // We should instead hard-split to maintain reasonable chunk sizes.
    const url = "https://example.com/very/long/path/that/exceeds/the/limit/without/any/spaces";
    const text = `链接：${url}`;

    const chunks = chunkDiscordText(text, { maxChars: 30, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    // The first chunk should be substantial (hard split at 30), not just "链接："
    expect(chunks[0].length).toBe(30);
    expect(chunks.join("")).toBe(text);
  });

  it("accepts CJK punctuation at the very end of the window", () => {
    // When a CJK punctuation mark lands exactly at the window boundary
    // (i.e., the last character of the window), we should still split
    // after it rather than falling back to a less ideal break point.
    // Build a string where the 20th character is a period and text continues.
    const before = "这是一段测试文本用来验证边界情况的处理。"; // 19 chars + 。 = 20 chars
    const after = "后续的文本内容应该出现在第二个分块中";
    const text = before + after;

    const chunks = chunkDiscordText(text, { maxChars: 20, maxLines: 50 });

    expect(chunks.length).toBe(2);
    // The first chunk should include the punctuation mark.
    expect(chunks[0]).toBe(before);
    // The second chunk should start with the text after the punctuation.
    expect(chunks[1]).toBe(after);
  });
});
