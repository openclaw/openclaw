/** Tests text chunking helpers used by auto-reply delivery. */

import { describe, expect, it, vi } from "vitest";
import * as fences from "../../packages/markdown-core/src/fences.js";
import { hasBalancedFences } from "../test-utils/chunk-test-helpers.js";
import {
  chunkByNewline,
  chunkByParagraph,
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

function requireChunk(chunks: string[], index: number): string {
  const chunk = chunks[index];
  if (chunk === undefined) {
    throw new Error(`expected chunk ${index}`);
  }
  return chunk;
}

function expectChunkLengths(chunks: string[], expectedLengths: number[]) {
  expect(chunks).toHaveLength(expectedLengths.length);
  expectedLengths.forEach((length, index) => {
    expect(requireChunk(chunks, index).length).toBe(length);
  });
}

function expectNormalizedChunkJoin(chunks: string[], text: string) {
  expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
}

type ChunkCase = {
  name: string;
  text: string;
  limit: number;
  expected: string[];
};

function runChunkCases(chunker: (text: string, limit: number) => string[], cases: ChunkCase[]) {
  it.each(cases)("$name", ({ text, limit, expected }) => {
    expect(chunker(text, limit)).toEqual(expected);
  });
}

function expectMarkdownFenceSplitCases(
  cases: ReadonlyArray<{
    name: string;
    text: string;
    limit: number;
    expectedPrefix: string;
    expectedSuffix: string;
  }>,
) {
  cases.forEach(({ name, text, limit, expectedPrefix, expectedSuffix }) => {
    const chunks = chunkMarkdownText(text, limit);
    expect(chunks.length, name).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length, name).toBeLessThanOrEqual(limit);
      expect(chunk.startsWith(expectedPrefix), name).toBe(true);
      expect(chunk.trimEnd().endsWith(expectedSuffix), name).toBe(true);
    }
    expectFencesBalanced(chunks);
  });
}

function expectNoEmptyFencedChunks(text: string, limit: number) {
  const chunks = chunkMarkdownText(text, limit);
  for (const chunk of chunks) {
    const nonFenceLines = chunk
      .split("\n")
      .filter((line) => !/^( {0,3})(`{3,}|~{3,})(.*)$/.test(line));
    expect(nonFenceLines.join("\n").trim()).not.toBe("");
  }
}

function expectFenceParseOccursOnce(text: string, limit: number) {
  const parseSpy = vi.spyOn(fences, "parseFenceSpans");
  const chunks = chunkMarkdownText(text, limit);

  expect(chunks.length).toBeGreaterThan(2);
  expect(parseSpy).toHaveBeenCalledTimes(1);
  parseSpy.mockRestore();
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

const newlineModeFenceCases = (() => {
  const fence = "```python\ndef my_function():\n    x = 1\n\n    y = 2\n    return x + y\n```";
  return [
    {
      name: "keeps short fenced block and following paragraph together",
      text: `${fence}\n\nAfter`,
      limit: 1000,
      expected: [`${fence}\n\nAfter`],
    },
    {
      name: "splits oversized fenced block away from following paragraph",
      text: `${fence}\n\nAfter`,
      limit: fence.length + 1,
      expected: [fence, "After"],
    },
  ] as const;
})();

describe("chunkText", () => {
  it.each([
    {
      name: "keeps multi-line text in one chunk when under limit",
      text: "Line one\n\nLine two\n\nLine three",
      limit: 1600,
      assert: (chunks: string[], text: string) => {
        expect(chunks).toEqual([text]);
      },
    },
    {
      name: "prefers breaking at a newline before the limit",
      text: "paragraph one line\n\nparagraph two starts here and continues",
      limit: 40,
      assert: (chunks: string[]) => {
        expect(chunks).toEqual(["paragraph one line", "paragraph two starts here and continues"]);
      },
    },
    {
      name: "otherwise breaks at the last whitespace under the limit",
      text: "This is a message that should break nicely near a word boundary.",
      limit: 30,
      assert: (chunks: string[], text: string) => {
        expect(requireChunk(chunks, 0).length).toBeLessThanOrEqual(30);
        expect(requireChunk(chunks, 1).length).toBeLessThanOrEqual(30);
        expectNormalizedChunkJoin(chunks, text);
      },
    },
    {
      name: "trims trailing whitespace from the final outbound reply chunk",
      text: "alpha beta   ",
      limit: 8,
      assert: (chunks: string[]) => {
        expect(chunks).toEqual(["alpha", "beta"]);
      },
    },
    {
      name: "falls back to a hard break when no whitespace is present",
      text: "Supercalifragilisticexpialidocious",
      limit: 10,
      assert: (chunks: string[]) => {
        expect(chunks).toEqual(["Supercalif", "ragilistic", "expialidoc", "ious"]);
      },
    },
  ] as const)("$name", ({ text, limit, assert }) => {
    assert(chunkText(text, limit), text);
  });

  runChunkCases(chunkText, [
    ...parentheticalCases,
    {
      name: "uses later whitespace when the only newline is at index zero",
      text: "\na bcd",
      limit: 5,
      expected: ["\na", "bcd"],
    },
    {
      name: "selects Unicode whitespace as a chunk boundary",
      text: "ab\u00a0cdef",
      limit: 5,
      expected: ["ab", "cdef"],
    },
    {
      name: "retains the whitespace base of a combining cluster after a cut",
      text: "ab \u0301cd",
      limit: 2,
      expected: ["ab", " \u0301", "cd"],
    },
  ]);
});

describe("chunkByParagraph code boundaries", () => {
  it("leaves oversized indented code intact for a render-aware chunker", () => {
    const text = `    ${"A".repeat(128)}\n\n    ${"B".repeat(128)}`;
    expect(chunkByParagraph(text, 256, { splitLongParagraphs: false })).toEqual([text]);
  });
});

describe("chunkByParagraph Unicode line/paragraph separators", () => {
  it.each([
    {
      name: "treats lone U+2029 as a standalone paragraph boundary",
      text: "paragraph one\u2029paragraph two starts here",
      normalized: "paragraph one\n\nparagraph two starts here",
      limit: 39,
      expected: ["paragraph one", "paragraph two starts here"],
    },
    {
      name: "treats lone U+2028 as a line break within one paragraph",
      text: "paragraph one line\u2028still same paragraph",
      normalized: "paragraph one line\nstill same paragraph",
      limit: 50,
      expected: ["paragraph one line\nstill same paragraph"],
    },
    {
      name: "treats consecutive U+2028 and U+2029 as a paragraph boundary",
      text: "paragraph one line\u2028\u2029paragraph two starts here",
      normalized: "paragraph one line\n\nparagraph two starts here",
      limit: 40,
      expected: ["paragraph one line", "paragraph two starts here"],
    },
    ...["\u2028", "\u2029"].map((separator) => ({
      name: `retains a paragraph boundary after CR followed by ${JSON.stringify(separator)}`,
      text: `first\r${separator}second`,
      normalized: "first\n\nsecond",
      limit: 4000,
      expected: ["first\n\nsecond"],
    })),
    {
      name: "retains a prepended whitespace cluster before a paragraph separator",
      text: "alpha\u0600 \u2029beta",
      normalized: "alpha\u0600 \n\nbeta",
      limit: 100,
      expected: ["alpha\u0600 \n\nbeta"],
    },
  ] as const)("$name", ({ text, normalized, limit, expected }) => {
    const chunks = chunkByParagraph(text, limit);

    expect(chunks).toEqual(expected);
    expect(chunks).toEqual(chunkByParagraph(normalized, limit));
  });
});

describe("resolveTextChunkLimit", () => {
  it.each([
    {
      name: "uses the default limit",
      cfg: undefined,
      provider: "telegram" as const,
      accountId: undefined,
      options: undefined,
      expected: 4000,
    },
    {
      name: "uses fallback limit override when provided",
      cfg: undefined,
      provider: "discord" as const,
      accountId: undefined,
      options: { fallbackLimit: 2000 },
      expected: 2000,
    },
    {
      name: "supports provider overrides for telegram",
      cfg: { channels: { telegram: { textChunkLimit: 1234 } } },
      provider: "telegram" as const,
      accountId: undefined,
      options: undefined,
      expected: 1234,
    },
    {
      name: "falls back when provider override does not match",
      cfg: { channels: { telegram: { textChunkLimit: 1234 } } },
      provider: "whatsapp" as const,
      accountId: undefined,
      options: undefined,
      expected: 4000,
    },
    {
      name: "prefers account overrides when provided",
      cfg: {
        channels: {
          telegram: {
            textChunkLimit: 2000,
            accounts: {
              default: { textChunkLimit: 1234 },
              primary: { textChunkLimit: 777 },
            },
          },
        },
      },
      provider: "telegram" as const,
      accountId: "primary",
      options: undefined,
      expected: 777,
    },
    {
      name: "ignores retired webchat textChunkLimit channel config",
      cfg: {
        channels: {
          webchat: { textChunkLimit: 16000 },
        },
      },
      provider: "webchat" as const,
      accountId: undefined,
      options: undefined,
      expected: 4000,
    },
  ] as const)("$name", ({ cfg, provider, accountId, options, expected }) => {
    expect(resolveTextChunkLimit(cfg as never, provider, accountId, options)).toBe(expected);
  });
});

describe("chunkMarkdownText", () => {
  it.each(["length", "newline"] as const)("preserves fenced whitespace in %s mode", (mode) => {
    for (const { body, limit, syntheticNewline } of [
      ...["    ", "\t", " \t "].map((indent) => ({
        body: `${indent}value = 1\n`.repeat(10),
        limit: 34,
        syntheticNewline: false,
      })),
      { body: "abc def ghi jkl mno", limit: 14, syntheticNewline: true },
    ]) {
      const chunks = chunkMarkdownTextWithMode(
        `\`\`\`txt\n${body}${syntheticNewline ? "\n" : ""}\`\`\``,
        limit,
        mode,
      );
      expect(chunks.length).toBeGreaterThan(1);
      expectFencesBalanced(chunks);
      expect
        .soft(chunks.map((chunk) => chunk.slice(7, syntheticNewline ? -4 : -3)).join(""), body)
        .toBe(body);
      expect(chunks.every((chunk) => chunk.length <= limit)).toBe(true);
    }
  });

  it.each([
    {
      name: "keeps fenced blocks intact when a safe break exists",
      run: () => {
        const prefix = "p".repeat(60);
        const fence = "```bash\nline1\nline2\n```";
        const suffix = "s".repeat(60);
        const text = `${prefix}\n\n${fence}\n\n${suffix}`;

        const chunks = chunkMarkdownText(text, 40);
        const intactFenceChunks = chunks.filter((chunk) => chunk.trimEnd() === fence);
        expect(intactFenceChunks.length).toBeGreaterThan(0);
        expectFencesBalanced(chunks);
      },
    },
    {
      name: "handles multiple fence marker styles when splitting inside fences",
      run: () =>
        expectMarkdownFenceSplitCases([
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
        ]),
    },
  ] as const)("$name", ({ run }) => {
    run();
  });

  runChunkCases(chunkMarkdownText, [
    ...parentheticalCases,
    {
      name: "preserves newline and whitespace boundaries after the first chunk",
      text: "aa bb\ncc dd\nee ff gg hh",
      limit: 6,
      expected: ["aa bb", "cc dd", "ee ff", "gg hh"],
    },
    {
      name: "retains whitespace with an attached combining mark at a prose cut",
      text: "abc \u0301def",
      limit: 4,
      expected: ["abc", " \u0301de", "f"],
    },
    {
      name: "consumes only one ordinary prose space at a cut",
      text: "abc  def",
      limit: 4,
      expected: ["abc", " def"],
    },
  ]);

  it("hard-breaks when a parenthetical exceeds the limit", () => {
    const text = `(${"a".repeat(80)})`;
    const chunks = chunkMarkdownText(text, 20);
    expect(requireChunk(chunks, 0).length).toBe(20);
    expect(chunks.join("")).toBe(text);
  });

  it("parses fence spans once for long fenced payloads", () => {
    expectFenceParseOccursOnce(`\`\`\`txt\n${"line\n".repeat(600)}\`\`\``, 80);
  });

  it.each([
    { payload: `token.${"A".repeat(4200)}`, limit: 4000, maxChunks: 3, bareReopen: false },
    { payload: "A".repeat(4200), limit: 2000, maxChunks: 4, bareReopen: true },
  ])(
    "bounds oversized fence headers at $limit characters",
    ({ payload, limit, maxChunks, bareReopen }) => {
      const chunks = chunkMarkdownText(`\`\`\`${payload}\n\`\`\``, limit);
      expect(chunks.length).toBeLessThanOrEqual(maxChunks);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(limit);
      }
      if (bareReopen) {
        expect(requireChunk(chunks, 1).startsWith("```\n")).toBe(true);
      } else {
        expect(chunks.join("").replaceAll("`", "").replaceAll("\n", "")).toBe(payload);
      }
      expectFencesBalanced(chunks.slice(1));
    },
  );

  it("keeps the full opening line when it fits the reopen budget", () => {
    const openLine = `\`\`\`language-${"A".repeat(1_488)}`;
    const chunks = chunkMarkdownText(`${openLine}\n${"x".repeat(1_200)}\n\`\`\``, 2_000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(1)) {
      expect(chunk.startsWith(`${openLine}\n`)).toBe(true);
    }
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expectFencesBalanced(chunks);
  });

  it("keeps the hard limit when synthetic fence balancing cannot fit", () => {
    const text = `\`\`\`\n${"x".repeat(20)}\n\`\`\``;
    for (const limit of [5, 6, 8]) {
      const chunks = chunkMarkdownText(text, limit);
      expect(
        chunks.every((chunk) => chunk.length <= limit),
        `limit ${limit}`,
      ).toBe(true);
      expect(chunks.length, `limit ${limit}`).toBeLessThanOrEqual(Math.ceil(text.length / limit));
      expect(chunks.join(""), `limit ${limit}`).toBe(text);
    }
  });

  it.each([
    { text: `\`\`\`txt\n${"a".repeat(300)}\n\`\`\``, limit: 60 },
    { text: `\`\`\`${"x".repeat(12)}\nbody-content-long\n\`\`\``, limit: 20 },
  ])("never emits empty fenced chunks at limit $limit", ({ text, limit }) => {
    const chunks = chunkMarkdownText(text, limit);
    expect(chunks.every((chunk) => chunk.length <= limit)).toBe(true);
    expectNoEmptyFencedChunks(text, limit);
  });
});

describe("chunkByNewline", () => {
  it.each([
    [
      "line breaks",
      "Line one\nLine two\nLine three",
      1000,
      ["Line one", "Line two", "Line three"],
      undefined,
    ],
    [
      "blank folding",
      "Line one\n\n\nLine two\n\nLine three",
      1000,
      ["Line one", "\n\nLine two", "\nLine three"],
      undefined,
    ],
    ["trim", "  Line one  \n  Line two  ", 1000, ["Line one", "Line two"], undefined],
    [
      "whole whitespace graphemes",
      " \u0301line\u0600  \n next ",
      1000,
      [" \u0301line\u0600 ", "next"],
      undefined,
    ],
    [
      "leading blank lines",
      "\n\nLine one\nLine two",
      1000,
      ["\n\nLine one", "Line two"],
      undefined,
    ],
    ["trailing blank lines", "Line one\n\n", 1000, ["Line one\n\n"], undefined],
    ["capped blank lines", "x" + "\n".repeat(50), 10, ["x" + "\n".repeat(9)], undefined],
    ["full chunk", "abcdefghij\n\n", 10, ["abcdefghij"], undefined],
    ["astral suffix budget", "😀\n\n", 3, ["😀\n"], undefined],
    ["astral leading budget", "\n😀", 2, ["😀"], undefined],
    ["astral interior budget", "a\n\n😀", 2, ["a", "😀"], undefined],
    ["fractional budget", "\n😀\n\n", 2.9, ["😀"], undefined],
    ["indivisible code point", "😀\n\n", 1, ["😀"], undefined],
    ["unsplit long lines", "abcdefghij\n\n", 3, ["abcdefghij"], { splitLongLines: false }],
    ["untrimmed trailing budget", "  x \n\n", 5, ["  x \n"], { trimLines: false }],
    ["disabled limit", "x\n\n", 0, ["x\n\n"], undefined],
    [
      "untrimmed lines",
      "  indented line  \nNext",
      1000,
      ["  indented line  ", "Next"],
      { trimLines: false },
    ],
  ] as const)("respects %s", (_name, text, limit, expected, options) => {
    expect(chunkByNewline(text, limit, options)).toEqual(expected);
  });

  it("falls back to length-based for long lines", () => {
    const text = "Short line\n" + "a".repeat(50) + "\nAnother short";
    const chunks = chunkByNewline(text, 20);
    expect(chunks[0]).toBe("Short line");
    expectChunkLengths(chunks.slice(1, 4), [20, 20, 10]);
    expect(chunks[4]).toBe("Another short");
  });

  it.each(["", "   \n\n   "] as const)("returns empty array for input %j", (text) => {
    expect(chunkByNewline(text, 100)).toStrictEqual([]);
  });
});

describe("chunkTextWithMode", () => {
  it.each([
    {
      name: "length mode",
      text: "Line one\nLine two",
      mode: "length" as const,
      expected: ["Line one\nLine two"],
    },
    {
      name: "newline mode packs short blank-line-separated paragraphs",
      text: "Para one\n\nPara two",
      mode: "newline" as const,
      expected: ["Para one\n\nPara two"],
    },
  ] as const)(
    "applies mode-specific chunking behavior: $name",
    ({ text, mode, expected, name }) => {
      expect(chunkTextWithMode(text, 1000, mode), name).toEqual(expected);
    },
  );
});

describe("chunkMarkdownTextWithMode", () => {
  it.each(newlineModeFenceCases)(
    "handles newline mode fence splitting rules: $name",
    ({ text, limit, expected, name }) => {
      expect(chunkMarkdownTextWithMode(text, limit, "newline"), name).toEqual(expected);
    },
  );

  it("packs multiple paragraphs up to the limit in newline mode", () => {
    expect(chunkMarkdownTextWithMode("Alpha\n\nBeta\n\nGamma", 14, "newline")).toEqual([
      "Alpha\n\nBeta",
      "Gamma",
    ]);
  });

  it("keeps an astral character whole when a positive hard limit starts on its pair", () => {
    expect(chunkMarkdownTextWithMode("A😀B", 1, "length")).toEqual(["A", "😀", "B"]);
  });

  it.each(["length", "newline"] as const)(
    "keeps astral text with a fractional limit in %s mode",
    (mode) => {
      expect(chunkMarkdownTextWithMode("😀", 1.5, mode)).toEqual(["😀"]);
    },
  );
});

describe("resolveChunkMode", () => {
  const providerCfg = {
    channels: { signal: { streaming: { chunkMode: "newline" as const } } },
  };
  const accountCfg = {
    channels: {
      signal: {
        streaming: { chunkMode: "length" as const },
        accounts: {
          primary: { streaming: { chunkMode: "newline" as const } },
        },
      },
    },
  };

  it.each([
    { cfg: undefined, provider: "telegram", accountId: undefined, expected: "length" },
    { cfg: providerCfg, provider: "__internal__", accountId: undefined, expected: "length" },
    { cfg: providerCfg, provider: "signal", accountId: undefined, expected: "newline" },
    { cfg: providerCfg, provider: "discord", accountId: undefined, expected: "length" },
    { cfg: accountCfg, provider: "signal", accountId: "primary", expected: "newline" },
    { cfg: accountCfg, provider: "signal", accountId: "other", expected: "length" },
  ] as const)(
    "resolves default/provider/account/internal chunk mode for $provider $accountId",
    ({ cfg, provider, accountId, expected }) => {
      expect(resolveChunkMode(cfg as never, provider, accountId)).toBe(expected);
    },
  );
});

describe("auto-reply grapheme boundaries", () => {
  const markdownLength = (text: string, limit: number) =>
    chunkMarkdownTextWithMode(text, limit, "length");
  it.each([
    { chunker: chunkByNewline, text: "😀".repeat(30), limit: 11 },
    { chunker: markdownLength, text: `a${"😀".repeat(20_000)}`, limit: 32_768 },
    { chunker: chunkByNewline, text: "😀😀", limit: 1.5, expected: ["😀", "😀"] },
  ])("preserves surrogates at a hard boundary of $limit", ({ chunker, text, limit, expected }) => {
    const chunks = chunker(text, limit);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk))).toBe(true);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/u.test(chunk))).toBe(true);
    if (expected) {
      expect(chunks).toEqual(expected);
      expect(chunks).not.toContain("");
    }
  });

  it.each([
    ...[chunkByNewline, chunkMarkdownText].flatMap((chunker) => [
      { chunker, text: "aaaaaaaaaa👨‍👩‍👧‍👦Z", limit: 12, expected: ["aaaaaaaaaa", "👨‍👩‍👧‍👦Z"] },
      { chunker, text: "👨‍👩‍👧‍👦", limit: 4, expected: ["👨‍", "👩‍", "👧‍", "👦"] },
    ]),
    {
      chunker: chunkMarkdownText,
      text: "\u0600 \u0301abcd",
      limit: 4,
      expected: ["\u0600 \u0301a", "bcd"],
    },
    {
      chunker: chunkByNewline,
      text: "head\n\n\n\n\n\n\n👨‍👩‍👧‍👦Z",
      limit: 12,
      expected: ["head", "\n👨‍👩‍👧‍👦", "Z"],
    },
    {
      chunker: chunkMarkdownText,
      text: "```txt\naaaaaaaaaaa👨‍👩‍👧‍👦Z\n```",
      limit: 24,
      expected: ["```txt\naaaaaaaaaaa\n```", "```txt\n👨‍👩‍👧‍👦Z\n```"],
    },
  ])("preserves graphemes with limit $limit in $text", ({ chunker, text, limit, expected }) => {
    expect(chunker(text, limit)).toEqual(expected);
  });
});
