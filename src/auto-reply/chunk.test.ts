import { describe, expect, it } from "vitest";
import { hasBalancedFences } from "../test-utils/chunk-test-helpers.js";
import {
  chunkByNewline,
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "./chunk.js";

function expectFencesBalanced(chunks: string[]) {
  for (const chunk of chunks) {
    expect(hasBalancedFences(chunk)).toBe(true);
  }
}

type ChunkCase = {
  name: string;
  text: string;
  limit: number;
  expected: string[];
};

function runChunkCases(chunker: (text: string, limit: number) => string[], cases: ChunkCase[]) {
  for (const { name, text, limit, expected } of cases) {
    it(name, () => {
      expect(chunker(text, limit)).toEqual(expected);
    });
  }
}

const parentheticalCases: ChunkCase[] = [
  {
    name: "keeps parenthetical phrases together",
    text: "Heads up now (Though now I'm curious)ok",
    limit: 35,
    expected: ["Heads up now", "(Though now I'm curious)ok"],
  },
  {
    name: "handles nested parentheses",
    text: "Hello (outer (inner) end) world",
    limit: 26,
    expected: ["Hello (outer (inner) end)", "world"],
  },
  {
    name: "ignores unmatched closing parentheses",
    text: "Hello) world (ok)",
    limit: 12,
    expected: ["Hello)", "world (ok)"],
  },
];

describe("chunkText", () => {
  it("keeps multi-line text in one chunk when under limit", () => {
    const text = "Line one\n\nLine two\n\nLine three";
    const chunks = chunkText(text, 1600);
    expect(chunks).toEqual([text]);
  });

  it("splits only when text exceeds the limit", () => {
    const part = "a".repeat(20);
    const text = part.repeat(5); // 100 chars
    const chunks = chunkText(text, 60);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(60);
    expect(chunks[1].length).toBe(40);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers breaking at a newline before the limit", () => {
    const text = `paragraph one line\n\nparagraph two starts here and continues`;
    const chunks = chunkText(text, 40);
    expect(chunks).toEqual(["paragraph one line", "paragraph two starts here and continues"]);
  });

  it("otherwise breaks at the last whitespace under the limit", () => {
    const text = "This is a message that should break nicely near a word boundary.";
    const chunks = chunkText(text, 30);
    expect(chunks[0].length).toBeLessThanOrEqual(30);
    expect(chunks[1].length).toBeLessThanOrEqual(30);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("falls back to a hard break when no whitespace is present", () => {
    const text = "Supercalifragilisticexpialidocious"; // 34 chars
    const chunks = chunkText(text, 10);
    expect(chunks).toEqual(["Supercalif", "ragilistic", "expialidoc", "ious"]);
  });

  runChunkCases(chunkText, [parentheticalCases[0]]);
});

describe("resolveTextChunkLimit", () => {
  it("uses per-provider defaults", () => {
    expect(resolveTextChunkLimit(undefined, "whatsapp")).toBe(4000);
    expect(resolveTextChunkLimit(undefined, "telegram")).toBe(4000);
    expect(resolveTextChunkLimit(undefined, "slack")).toBe(4000);
    expect(resolveTextChunkLimit(undefined, "signal")).toBe(4000);
    expect(resolveTextChunkLimit(undefined, "imessage")).toBe(4000);
    expect(resolveTextChunkLimit(undefined, "discord")).toBe(4000);
    expect(
      resolveTextChunkLimit(undefined, "discord", undefined, {
        fallbackLimit: 2000,
      }),
    ).toBe(2000);
  });

  it("supports provider overrides", () => {
    const cfg = { channels: { telegram: { textChunkLimit: 1234 } } };
    expect(resolveTextChunkLimit(cfg, "whatsapp")).toBe(4000);
    expect(resolveTextChunkLimit(cfg, "telegram")).toBe(1234);
  });

  it("prefers account overrides when provided", () => {
    const cfg = {
      channels: {
        telegram: {
          textChunkLimit: 2000,
          accounts: {
            default: { textChunkLimit: 1234 },
            primary: { textChunkLimit: 777 },
          },
        },
      },
    };
    expect(resolveTextChunkLimit(cfg, "telegram", "primary")).toBe(777);
    expect(resolveTextChunkLimit(cfg, "telegram", "default")).toBe(1234);
  });

  it("uses the matching provider override", () => {
    const cfg = {
      channels: {
        discord: { textChunkLimit: 111 },
        slack: { textChunkLimit: 222 },
      },
    };
    expect(resolveTextChunkLimit(cfg, "discord")).toBe(111);
    expect(resolveTextChunkLimit(cfg, "slack")).toBe(222);
    expect(resolveTextChunkLimit(cfg, "telegram")).toBe(4000);
  });
});

describe("chunkMarkdownText", () => {
  it("keeps fenced blocks intact when a safe break exists", () => {
    const prefix = "p".repeat(60);
    const fence = "```bash\nline1\nline2\n```";
    const suffix = "s".repeat(60);
    const text = `${prefix}\n\n${fence}\n\n${suffix}`;

    const chunks = chunkMarkdownText(text, 40);
    expect(chunks.some((chunk) => chunk.trimEnd() === fence)).toBe(true);
    expectFencesBalanced(chunks);
  });

  it("handles multiple fence marker styles when splitting inside fences", () => {
    const cases = [
      {
        name: "backtick fence",
        text: `\`\`\`txt\n${"a".repeat(500)}\n\`\`\``,
        limit: 120,
        expectedPrefix: "```txt\n",
        expectedSuffix: "```",
      },
      {
        name: "tilde fence",
        text: `~~~sh\n${"x".repeat(600)}\n~~~`,
        limit: 140,
        expectedPrefix: "~~~sh\n",
        expectedSuffix: "~~~",
      },
      {
        name: "long backtick fence",
        text: `\`\`\`\`md\n${"y".repeat(600)}\n\`\`\`\``,
        limit: 140,
        expectedPrefix: "````md\n",
        expectedSuffix: "````",
      },
      {
        name: "indented fence",
        text: `  \`\`\`js\n  ${"z".repeat(600)}\n  \`\`\``,
        limit: 160,
        expectedPrefix: "  ```js\n",
        expectedSuffix: "  ```",
      },
    ] as const;

    for (const testCase of cases) {
      const chunks = chunkMarkdownText(testCase.text, testCase.limit);
      expect(chunks.length, testCase.name).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length, testCase.name).toBeLessThanOrEqual(testCase.limit);
        expect(chunk.startsWith(testCase.expectedPrefix), testCase.name).toBe(true);
        expect(chunk.trimEnd().endsWith(testCase.expectedSuffix), testCase.name).toBe(true);
      }
      expectFencesBalanced(chunks);
    }
  });

  it("never produces an empty fenced chunk when splitting", () => {
    const text = `\`\`\`txt\n${"a".repeat(300)}\n\`\`\``;
    const chunks = chunkMarkdownText(text, 60);
    for (const chunk of chunks) {
      const nonFenceLines = chunk
        .split("\n")
        .filter((line) => !/^( {0,3})(`{3,}|~{3,})(.*)$/.test(line));
      expect(nonFenceLines.join("\n").trim()).not.toBe("");
    }
  });

  runChunkCases(chunkMarkdownText, parentheticalCases);

  it("hard-breaks when a parenthetical exceeds the limit", () => {
    const text = `(${"a".repeat(80)})`;
    const chunks = chunkMarkdownText(text, 20);
    expect(chunks[0]?.length).toBe(20);
    expect(chunks.join("")).toBe(text);
  });
});

describe("chunkByNewline", () => {
  it("splits text on newlines", () => {
    const text = "Line one\nLine two\nLine three";
    const chunks = chunkByNewline(text, 1000);
    expect(chunks).toEqual(["Line one", "Line two", "Line three"]);
  });

  it("preserves blank lines by folding into the next chunk", () => {
    const text = "Line one\n\n\nLine two\n\nLine three";
    const chunks = chunkByNewline(text, 1000);
    expect(chunks).toEqual(["Line one", "\n\nLine two", "\nLine three"]);
  });

  it("trims whitespace from lines", () => {
    const text = "  Line one  \n  Line two  ";
    const chunks = chunkByNewline(text, 1000);
    expect(chunks).toEqual(["Line one", "Line two"]);
  });

  it("preserves leading blank lines on the first chunk", () => {
    const text = "\n\nLine one\nLine two";
    const chunks = chunkByNewline(text, 1000);
    expect(chunks).toEqual(["\n\nLine one", "Line two"]);
  });

  it("falls back to length-based for long lines", () => {
    const text = "Short line\n" + "a".repeat(50) + "\nAnother short";
    const chunks = chunkByNewline(text, 20);
    expect(chunks[0]).toBe("Short line");
    // Long line gets split into multiple chunks
    expect(chunks[1].length).toBe(20);
    expect(chunks[2].length).toBe(20);
    expect(chunks[3].length).toBe(10);
    expect(chunks[4]).toBe("Another short");
  });

  it("does not split long lines when splitLongLines is false", () => {
    const text = "a".repeat(50);
    const chunks = chunkByNewline(text, 20, { splitLongLines: false });
    expect(chunks).toEqual([text]);
  });

  it("returns empty array for empty and whitespace-only input", () => {
    for (const text of ["", "   \n\n   "]) {
      expect(chunkByNewline(text, 100)).toEqual([]);
    }
  });

  it("preserves trailing blank lines on the last chunk", () => {
    const text = "Line one\n\n";
    const chunks = chunkByNewline(text, 1000);
    expect(chunks).toEqual(["Line one\n\n"]);
  });

  it("keeps whitespace when trimLines is false", () => {
    const text = "  indented line  \nNext";
    const chunks = chunkByNewline(text, 1000, { trimLines: false });
    expect(chunks).toEqual(["  indented line  ", "Next"]);
  });
});

describe("chunkTextWithMode", () => {
  it("applies mode-specific chunking behavior", () => {
    const cases = [
      {
        name: "length mode",
        text: "Line one\nLine two",
        mode: "length" as const,
        expected: ["Line one\nLine two"],
      },
      {
        name: "newline mode (single paragraph)",
        text: "Line one\nLine two",
        mode: "newline" as const,
        expected: ["Line one\nLine two"],
      },
      {
        name: "newline mode (blank-line split)",
        text: "Para one\n\nPara two",
        mode: "newline" as const,
        expected: ["Para one", "Para two"],
      },
    ] as const;

    for (const testCase of cases) {
      const chunks = chunkTextWithMode(testCase.text, 1000, testCase.mode);
      expect(chunks, testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("chunkMarkdownTextWithMode", () => {
  it("applies markdown/newline mode behavior", () => {
    const cases = [
      {
        name: "length mode uses markdown-aware chunker",
        text: "Line one\nLine two",
        mode: "length" as const,
        expected: chunkMarkdownText("Line one\nLine two", 1000),
      },
      {
        name: "newline mode keeps single paragraph",
        text: "Line one\nLine two",
        mode: "newline" as const,
        expected: ["Line one\nLine two"],
      },
      {
        name: "newline mode splits by blank line",
        text: "Para one\n\nPara two",
        mode: "newline" as const,
        expected: ["Para one", "Para two"],
      },
    ] as const;
    for (const testCase of cases) {
      expect(chunkMarkdownTextWithMode(testCase.text, 1000, testCase.mode), testCase.name).toEqual(
        testCase.expected,
      );
    }
  });

  it("handles newline mode fence splitting rules", () => {
    const fence = "```python\ndef my_function():\n    x = 1\n\n    y = 2\n    return x + y\n```";
    const longFence = `\`\`\`js\n${"const a = 1;\n".repeat(20)}\`\`\``;
    const cases = [
      {
        name: "keeps single-newline fence+paragraph together",
        text: "```js\nconst a = 1;\nconst b = 2;\n```\nAfter",
        limit: 1000,
        expected: ["```js\nconst a = 1;\nconst b = 2;\n```\nAfter"],
      },
      {
        name: "keeps blank lines inside fence together",
        text: fence,
        limit: 1000,
        expected: [fence],
      },
      {
        name: "splits between fence and following paragraph",
        text: `${fence}\n\nAfter`,
        limit: 1000,
        expected: [fence, "After"],
      },
      {
        name: "defers long markdown blocks to markdown chunker",
        text: longFence,
        limit: 40,
        expected: chunkMarkdownText(longFence, 40),
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        chunkMarkdownTextWithMode(testCase.text, testCase.limit, "newline"),
        testCase.name,
      ).toEqual(testCase.expected);
    }
  });
});

describe("resolveChunkMode", () => {
  it("resolves default, provider, account, and internal channel modes", () => {
    const providerCfg = { channels: { slack: { chunkMode: "newline" as const } } };
    const accountCfg = {
      channels: {
        slack: {
          chunkMode: "length" as const,
          accounts: {
            primary: { chunkMode: "newline" as const },
          },
        },
      },
    };
    const cases = [
      { cfg: undefined, provider: "telegram", accountId: undefined, expected: "length" },
      { cfg: {}, provider: "discord", accountId: undefined, expected: "length" },
      { cfg: undefined, provider: "bluebubbles", accountId: undefined, expected: "length" },
      { cfg: providerCfg, provider: "__internal__", accountId: undefined, expected: "length" },
      { cfg: providerCfg, provider: "slack", accountId: undefined, expected: "newline" },
      { cfg: providerCfg, provider: "discord", accountId: undefined, expected: "length" },
      { cfg: accountCfg, provider: "slack", accountId: "primary", expected: "newline" },
      { cfg: accountCfg, provider: "slack", accountId: "other", expected: "length" },
    ] as const;

    for (const testCase of cases) {
      expect(resolveChunkMode(testCase.cfg as never, testCase.provider, testCase.accountId)).toBe(
        testCase.expected,
      );
    }
  });
});
