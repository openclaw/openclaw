/** Tests text chunking helpers used by auto-reply delivery. */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
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
  return expectDefined(chunks[index], `chunk ${index}`);
}

function expectNormalizedChunkJoin(chunks: string[], text: string) {
  expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
}

type ChunkCase = [text: string, limit: number, expected: string[]];

function runChunkCases(chunker: (text: string, limit: number) => string[], cases: ChunkCase[]) {
  it.each(cases)("chunks %j at %i", (text, limit, expected) => {
    expect(chunker(text, limit)).toEqual(expected);
  });
}

function expectNoEmptyFencedChunks(chunks: string[]) {
  for (const chunk of chunks) {
    const nonFenceLines = chunk
      .split("\n")
      .filter((line) => !/^( {0,3})(`{3,}|~{3,})(.*)$/.test(line));
    expect(nonFenceLines.join("\n").trim()).not.toBe("");
  }
}

const parentheticalCases: ChunkCase[] = [
  ["Heads up now (Though now I'm curious)ok", 35, ["Heads up now", "(Though now I'm curious)ok"]],
  ["Hello (outer (inner) end) world", 26, ["Hello (outer (inner) end)", "world"]],
  ["Hello) world (ok)", 12, ["Hello)", "world (ok)"]],
];

const newlineModeFence =
  "```python\ndef my_function():\n    x = 1\n\n    y = 2\n    return x + y\n```";

describe("chunkText", () => {
  it("breaks at the last whitespace", () => {
    const text = "This is a message that should break nicely near a word boundary.";
    const chunks = chunkText(text, 30);
    expect(requireChunk(chunks, 0).length).toBeLessThanOrEqual(30);
    expect(requireChunk(chunks, 1).length).toBeLessThanOrEqual(30);
    expectNormalizedChunkJoin(chunks, text);
  });
  const multiline = "Line one\n\nLine two\n\nLine three";
  runChunkCases(chunkText, [
    [multiline, 1600, [multiline]],
    [
      "paragraph one line\n\nparagraph two starts here and continues",
      40,
      ["paragraph one line", "paragraph two starts here and continues"],
    ],
    ...parentheticalCases,
    ["\na bcd", 5, ["\na", "bcd"]],
    ["ab\u00a0cdef", 5, ["ab", "cdef"]],
  ]);
});

it("chunkByParagraph leaves oversized indented code intact for a render-aware chunker", () => {
  const text = `    ${"A".repeat(128)}\n\n    ${"B".repeat(128)}`;
  expect(chunkByParagraph(text, 256, { splitLongParagraphs: false })).toEqual([text]);
});

describe("chunkByParagraph Unicode line/paragraph separators", () => {
  it.each([
    [
      "paragraph one\u2029paragraph two starts here",
      "paragraph one\n\nparagraph two starts here",
      39,
      ["paragraph one", "paragraph two starts here"],
    ],
    [
      "paragraph one line\u2028still same paragraph",
      "paragraph one line\nstill same paragraph",
      50,
      ["paragraph one line\nstill same paragraph"],
    ],
    [
      "paragraph one line\u2028\u2029paragraph two starts here",
      "paragraph one line\n\nparagraph two starts here",
      40,
      ["paragraph one line", "paragraph two starts here"],
    ],
    ...["\u2028", "\u2029"].map(
      (separator) =>
        [`first\r${separator}second`, "first\n\nsecond", 4000, ["first\n\nsecond"]] as const,
    ),
    ["alpha\u0600 \u2029beta", "alpha\u0600 \n\nbeta", 100, ["alpha\u0600 \n\nbeta"]],
  ] as const)("normalizes separators in %j", (text, normalized, limit, expected) => {
    const chunks = chunkByParagraph(text, limit);

    expect(chunks).toEqual(expected);
    expect(chunks).toEqual(chunkByParagraph(normalized, limit));
  });
});

describe("resolveTextChunkLimit", () => {
  const telegram = { channels: { telegram: { textChunkLimit: 1234 } } };
  const accounts = {
    channels: {
      telegram: {
        textChunkLimit: 2000,
        accounts: { default: { textChunkLimit: 1234 }, primary: { textChunkLimit: 777 } },
      },
    },
  };
  it.each([
    ["default", undefined, "telegram", undefined, undefined, 4000],
    ["fallback override", undefined, "discord", undefined, { fallbackLimit: 2000 }, 2000],
    ["provider override", telegram, "telegram", undefined, undefined, 1234],
    ["unmatched provider", telegram, "whatsapp", undefined, undefined, 4000],
    ["account override", accounts, "telegram", "primary", undefined, 777],
    ["default account", accounts, "telegram", "default", undefined, 1234],
    [
      "retired webchat config",
      { channels: { webchat: { textChunkLimit: 16000 } } },
      "webchat",
      undefined,
      undefined,
      4000,
    ],
  ] as const)("resolves %s limit", (_name, cfg, provider, accountId, options, expected) => {
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

  it("keeps fenced blocks intact at a safe break", () => {
    const fence = "```bash\nline1\nline2\n```";
    const chunks = chunkMarkdownText(`${"p".repeat(60)}\n\n${fence}\n\n${"s".repeat(60)}`, 40);
    expect(chunks.filter((chunk) => chunk.trimEnd() === fence).length).toBeGreaterThan(0);
    expectFencesBalanced(chunks);
  });

  it.each([
    ["```", "txt", "a".repeat(500), 120],
    ["~~~", "sh", "x".repeat(600), 140],
    ["````", "md", "y".repeat(600), 140],
    ["  ```", "js", `  ${"z".repeat(600)}`, 160],
  ] as const)("splits %s fences", (marker, language, body, limit) => {
    const prefix = `${marker}${language}\n`;
    const chunks = chunkMarkdownText(`${prefix}${body}\n${marker}`, limit);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
      expect(chunk.startsWith(prefix)).toBe(true);
      expect(chunk.trimEnd().endsWith(marker)).toBe(true);
    }
    expectFencesBalanced(chunks);
  });

  runChunkCases(chunkMarkdownText, [
    ...parentheticalCases,
    ["abc \u0301def", 4, ["abc", " \u0301de", "f"]],
    ["abc  def", 4, ["abc", " def"]],
  ]);

  it("hard-breaks when a parenthetical exceeds the limit", () => {
    const text = `(${"a".repeat(80)})`;
    const chunks = chunkMarkdownText(text, 20);
    expect(requireChunk(chunks, 0).length).toBe(20);
    expect(chunks.join("")).toBe(text);
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
    expectNoEmptyFencedChunks(chunks);
  });
});

describe("chunkByNewline", () => {
  const [one, two, three] = ["Line one", "Line two", "Line three"] as const;
  it.each([
    ["line breaks", `${one}\n${two}\n${three}`, 1000, [one, two, three], undefined],
    [
      "blank folding",
      `${one}\n\n\n${two}\n\n${three}`,
      1000,
      [one, `\n\n${two}`, `\n${three}`],
      undefined,
    ],
    ["trim", `  ${one}  \n  ${two}  `, 1000, [one, two], undefined],
    [
      "whole whitespace graphemes",
      " \u0301line\u0600  \n next ",
      1000,
      [" \u0301line\u0600 ", "next"],
      undefined,
    ],
    ["leading blank lines", `\n\n${one}\n${two}`, 1000, [`\n\n${one}`, two], undefined],
    ["trailing blank lines", `${one}\n\n`, 1000, [`${one}\n\n`], undefined],
    ["capped blank lines", "x" + "\n".repeat(50), 10, ["x" + "\n".repeat(9)], undefined],
    ["astral suffix budget", "😀\n\n", 3, ["😀\n"], undefined],
    ["astral leading budget", "\n😀", 2, ["😀"], undefined],
    ["astral interior budget", "a\n\n😀", 2, ["a", "😀"], undefined],
    ["fractional budget", "\n😀\n\n", 2.9, ["😀"], undefined],
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

  it.each(["", "   \n\n   "] as const)("returns empty array for input %j", (text) => {
    expect(chunkByNewline(text, 100)).toStrictEqual([]);
  });
});

describe("chunkTextWithMode", () => {
  it.each([
    ["length", "Line one\nLine two"],
    ["newline", "Para one\n\nPara two"],
  ] as const)("packs short text in %s mode", (mode, text) => {
    expect(chunkTextWithMode(text, 1000, mode)).toEqual([text]);
  });
});

describe("chunkMarkdownTextWithMode", () => {
  it.each([
    [1000, [`${newlineModeFence}\n\nAfter`]],
    [newlineModeFence.length + 1, [newlineModeFence, "After"]],
  ] as const)("packs fenced paragraphs at limit %s", (limit, expected) => {
    expect(chunkMarkdownTextWithMode(`${newlineModeFence}\n\nAfter`, limit, "newline")).toEqual(
      expected,
    );
  });

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
