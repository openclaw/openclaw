import { expect, it, vi } from "vitest";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../../agents/embedded-agent-utils.js";
import { assistantVisibleTextFilters } from "./assistant-visible-text.js";
import { canReuseMarkdownOwnership, findCodeOwnership } from "./code-regions.js";
import { createTextProjection } from "./text-projection.js";

const markdownOwnershipWork = vi.hoisted(() => ({ scannedCharacters: 0 }));

vi.mock("./code-regions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./code-regions.js")>();
  return {
    ...actual,
    findCodeOwnership(
      text: Parameters<typeof actual.findCodeOwnership>[0],
      options?: Parameters<typeof actual.findCodeOwnership>[1],
    ) {
      markdownOwnershipWork.scannedCharacters += text.length;
      return actual.findCodeOwnership(text, options);
    },
  };
});

vi.mock("../../../packages/markdown-core/src/markdown-code-regions.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../packages/markdown-core/src/markdown-code-regions.js")
    >();
  return {
    ...actual,
    findMarkdownCodeRegions(text: string) {
      markdownOwnershipWork.scannedCharacters += text.length;
      return actual.findMarkdownCodeRegions(text);
    },
  };
});

it("bounds prefix comparisons after a stripped trace line", () => {
  const answer =
    Array.from({ length: 256 }, (_, index) => `Step ${index}: ordinary prose.\n`).join("") +
    "Done.";
  const source = 'tool call: hidden {"path":"notes.md"}\n' + answer;
  const stream = createTextProjection(assistantVisibleTextFilters("delivery", true));
  const probe = vi.spyOn(String.prototype, "startsWith");
  let comparedCharacters = 0;
  let delivered = "";
  try {
    for (let offset = 0; offset < source.length; offset += 4) {
      const result = stream.append(source.slice(offset, offset + 4));
      delivered = result.delta === null ? result.text : delivered + result.delta;
    }
    comparedCharacters = probe.mock.calls.reduce((sum, [search]) => sum + search.length, 0);
  } finally {
    probe.mockRestore();
  }
  expect(stream.text).toBe(answer);
  expect(delivered).toBe(answer);
  expect(comparedCharacters).toBeGreaterThan(0);
  expect(comparedCharacters).toBeLessThan(source.length * 64);
});

it("keeps a trailing high surrogate pending until its visibility is known", () => {
  const stream = createTextProjection(assistantVisibleTextFilters("delivery", true));
  expect(stream.append("\uDB40")).toEqual({ text: "", delta: "" });
  expect(stream.append("\uDC67")).toEqual({ text: "", delta: "" });
  expect(stream.append("Answer")).toEqual({
    text: "\uDB40\uDC67Answer",
    delta: "\uDB40\uDC67Answer",
  });
  expect(stream.replace("\uDB40")).toEqual({ text: "", delta: null });
  expect(stream.append("x").text).toBe("\uDB40x");
  expect(stream.replace("\uD83D").text).toBe("");
  expect(stream.append("\uDE00").text).toBe("😀");
});

it("bounds classification work while invisible text streams", () => {
  const source = "\u200B".repeat(1024);
  const stream = createTextProjection(assistantVisibleTextFilters("delivery", true));
  const probe = vi.spyOn(RegExp.prototype, "test");
  let testedCharacters = 0;
  try {
    for (const char of source) {
      stream.append(char);
    }
    testedCharacters = probe.mock.calls.reduce((sum, [text]) => sum + text.length, 0);
  } finally {
    probe.mockRestore();
  }
  expect(stream.text).toBe("");
  expect(testedCharacters).toBeGreaterThan(0);
  expect(testedCharacters).toBeLessThan(source.length * 128);
  expect(stream.append("Visible")).toEqual({ text: source + "Visible", delta: source + "Visible" });
  expect(stream.replace("\u2060")).toEqual({ text: "", delta: null });
});

it("bounds Markdown ownership work for open tool calls and cited answers", () => {
  const payload = "x".repeat(4_096);
  const openCall = `[tool:write]\n{"path": "notes.txt", "content": "${payload}`;
  const openCallStream = createTextProjection(assistantVisibleTextFilters("delivery", true));
  markdownOwnershipWork.scannedCharacters = 0;
  for (let offset = 0; offset < openCall.length; offset += 4) {
    openCallStream.append(openCall.slice(offset, offset + 4));
  }
  expect(openCallStream.text).toBe(openCall);
  expect(markdownOwnershipWork.scannedCharacters).toBeLessThan(openCall.length * 16);

  const citedAnswer =
    "[1]: https://example.test/reference\n```json\n{}\n```\n" +
    "Answer with citation [1]. ".repeat(128) +
    "Done.";
  const citedStream = createAssistantVisibleStreamText("final_answer");
  const beforeCitedAnswer = markdownOwnershipWork.scannedCharacters;
  for (let offset = 0; offset < citedAnswer.length; offset += 4) {
    citedStream.append(citedAnswer.slice(offset, offset + 4));
  }
  expect(citedStream.text).toBe(citedAnswer);
  expect(markdownOwnershipWork.scannedCharacters - beforeCitedAnswer).toBeLessThan(
    citedAnswer.length * 16,
  );

  const settledAfterBlankTitle =
    '[1]: https://example.test/reference\n"unfinished\n\n' +
    "Answer with citation [1]. ".repeat(128) +
    "Done.";
  const settledTitleStream = createAssistantVisibleStreamText("final_answer");
  const beforeSettledTitle = markdownOwnershipWork.scannedCharacters;
  for (let offset = 0; offset < settledAfterBlankTitle.length; offset += 4) {
    settledTitleStream.append(settledAfterBlankTitle.slice(offset, offset + 4));
  }
  expect(settledTitleStream.text).toBe(settledAfterBlankTitle);
  expect(markdownOwnershipWork.scannedCharacters - beforeSettledTitle).toBeLessThan(
    settledAfterBlankTitle.length * 16,
  );

  const bibliography =
    Array.from({ length: 128 }, (_, index) => `[${index + 1}]: https://example.test/${index}`).join(
      "\n",
    ) + "\n\n";
  const bibliographyStream = createAssistantVisibleStreamText("final_answer");
  const beforeBibliography = markdownOwnershipWork.scannedCharacters;
  for (let offset = 0; offset < bibliography.length; offset += 4) {
    bibliographyStream.append(bibliography.slice(offset, offset + 4));
  }
  expect(bibliographyStream.text).toBe(
    sanitizeAssistantVisibleStreamText(bibliography, "final_answer"),
  );
  expect(markdownOwnershipWork.scannedCharacters - beforeBibliography).toBeLessThan(
    bibliography.length * 16,
  );

  const completedCall = '[tool:write]\n{"path":"notes.txt","content":"safe"}\n\n';
  const completedCallStream = createAssistantVisibleStreamText("final_answer");
  for (let offset = 0; offset < completedCall.length; offset += 4) {
    completedCallStream.append(completedCall.slice(offset, offset + 4));
  }
  expect(completedCallStream.text).toBe("");
});

it("refreshes ownership when streamed link and container syntax changes Markdown ownership", () => {
  const scenarios: Array<[string, string]> = [
    ["[label](/url (title\n`x\n[tool:read] {}\nx` trailing\n", "))\n"],
    ["[label](/url (title\n`x\n[tool:read] {}\nx` trailing\n)", ")\n"],
    ["![example `x\n[tool:read] {}\nx`][id]\n\n> [id]:\n", "> /url\n"],
    ["![example `x\n[tool:read] {}\nx`][id]\n\n- [id]:\n", "  /url\n"],
    ['[label](/url "title\n`x\n[tool:read] {}\nx` trailing\n', '")\n'],
    ['[label](/u(x) "title\n`x\n[tool:read] {}\nx` trailing\n', '")\n'],
    ['[label](/u(x)\n"title\n`x\n[tool:read] {}\nx` trailing\n', '")\n'],
  ];

  for (const chunks of scenarios) {
    const source = chunks.join("");
    const stream = createAssistantVisibleStreamText("final_answer");
    const pending = stream.append(chunks[0]);
    expect(pending.text).toContain("[tool:read] {}");

    const corrected = stream.append(chunks[1]);
    expect(corrected.delta).toBeNull();
    expect(corrected.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
    expect(corrected.text).not.toContain("[tool:read] {}");
  }
});

it.each([
  "![example `x\n[tool:read] {}\nx`][id]\n\nA | B\n--- | ---\n\n[id]: /url\n",
  "![example ``x\n[tool:read] {}\nx``][a\\]b]\n\nA | B\n--- | ---\n\n[a\\]b]: </url>\n",
  "![example `x\r\n[tool:read] {}\r\nx`][id]\r\n\r\nA | B\r\n--- | ---\r\n\r\n[id]: /url\r\n",
  ...['"', "'", "("].map(
    (quote) =>
      `[label](/url ${quote}title\n\`x\n[tool:read] {}\nx\` trailing${quote === "(" ? ")" : quote}${" ".repeat(80)})\n`,
  ),
  "[tool:read] {}\n\n[a\\]b]: /url\n\n![example `x\n[tool:read] {}\nx`][a\\]b]\n",
  "````text\n```\n[tool:read] {}\n<tool_call>literal</tool_call>\n<|assistant|>\n```\n````\n",
])("matches canonical Markdown at every streamed prefix %#", (source) => {
  const expected = Array.from({ length: source.length + 1 }, (_, end) =>
    sanitizeAssistantVisibleStreamText(source.slice(0, end), "final_answer"),
  );
  const partitions = [
    ...Array.from({ length: source.length + 1 }, (_, split) => [
      source.slice(0, split),
      source.slice(split),
    ]),
    source.split(""),
    Array.from({ length: Math.ceil(source.length / 4) }, (_, i) => source.slice(i * 4, i * 4 + 4)),
  ];
  for (const chunks of partitions) {
    const stream = createAssistantVisibleStreamText("final_answer");
    let length = 0;
    let delivered = "";
    for (const chunk of chunks) {
      length += chunk.length;
      const result = stream.append(chunk);
      delivered = result.delta === null ? result.text : delivered + result.delta;
      expect(result.text).toBe(expected[length]);
      expect(delivered).toBe(expected[length]);
    }
  }
  expect(expected.at(-1)?.includes("[tool:read] {}")).toBe(source.startsWith("````"));
});

it("rechecks ownership when a GFM table delimiter changes a paragraph", () => {
  const scenarios = [
    ["Intro `x\n[tool:read] {}\nx` | y\n", "--- ", "| ", "---", "\n"],
    ["Intro `x\n[tool:read] {}\nx` |\n---", ":\n"],
    ["Intro `x\n[tool:read] {}\nx` |\n --", ":\n"],
    ["Intro `x\n[tool:read] {}\nx` |\n -", ":\n"],
    ["Intro `x\n[tool:read] {}\nx` |\n:", "-\n"],
    ["Intro `x\n[tool:read] {}\nx` |\n:", "--\n"],
    ["Intro `x\n[tool:read] {}\nx` |   \n:", "-\n"],
  ] as const;

  for (const chunks of scenarios) {
    const source = chunks.join("");
    const stream = createAssistantVisibleStreamText("final_answer");

    expect(stream.append(chunks[0]).text).toContain("[tool:read] {}");
    for (const chunk of chunks.slice(1, -1)) {
      stream.append(chunk);
    }
    const corrected = stream.append(chunks.at(-1)!);

    expect(corrected.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
    expect(corrected.text).not.toContain("[tool:read] {}");
  }
});

it("refreshes ownership when a GFM table delimiter becomes invalid", () => {
  const suffix = "x\n";
  const prefixes = [
    ...["---:", "-:", "--:", ":-", ":--"].map(
      (delimiter) => `Intro \`x\n[tool:read] {}\nx\` |\n${delimiter}`,
    ),
    "Intro `x\n[tool:read] {}\nx`\n---:",
  ];

  for (const prefix of prefixes) {
    const source = prefix + suffix;
    const stream = createAssistantVisibleStreamText("final_answer");

    expect(stream.append(prefix).text).not.toContain("[tool:read] {}");

    const corrected = stream.append(suffix);

    expect(corrected.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
    expect(corrected.text).toContain("[tool:read] {}");
  }
});

it("invalidates table ownership for a blockquoted delimiter row", () => {
  const prefix = "> Intro `x\n[tool:read] {}\n> x` |\n> ---:";
  const suffix = "x\n";
  const source = prefix + suffix;
  const stream = createAssistantVisibleStreamText("final_answer");

  expect(stream.append(prefix).text).not.toContain("[tool:read] {}");

  const corrected = stream.append(suffix);

  expect(corrected.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
  expect(corrected.text).toContain("[tool:read] {}");
});

it("refreshes link-title ownership across blockquote prefixes", () => {
  const chunks = [
    '> [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n',
    '> "\n> ',
    ")\n",
  ] as const;
  const source = chunks.join("");
  const stream = createAssistantVisibleStreamText("final_answer");
  const pending = stream.append(chunks[0]);

  expect(pending.text).toContain("[tool:read] {}");
  stream.append(chunks[1]);
  expect(stream.text).toContain("[tool:read] {}");

  const corrected = stream.append(chunks[2]);

  expect(corrected.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
  expect(corrected.text).not.toContain("[tool:read] {}");
});

it("refreshes link-title ownership across nested blockquote prefixes", () => {
  const deepQuote = "> ".repeat(40);
  const scenarios = [
    ['>    > [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n', '>    > "\n>    > ', ")\n"],
    [
      `${deepQuote}[label](/url "title\n\`x\n[tool:read] {}\nx\` trailing\n`,
      `${deepQuote}"\n${deepQuote}`,
      ")\n",
    ],
    [
      '- item\n\n    > [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n',
      '    > "\n    > ',
      ")\n",
    ],
  ] as const;

  for (const chunks of scenarios) {
    const source = chunks.join("");
    const stream = createAssistantVisibleStreamText("final_answer");

    expect(stream.append(chunks[0]).text).toContain("[tool:read] {}");
    stream.append(chunks[1]);
    expect(stream.text).toContain("[tool:read] {}");

    const corrected = stream.append(chunks[2]);

    expect(corrected.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
    expect(corrected.text).not.toContain("[tool:read] {}");
  }
});

it("checks repeated blockquote prefixes without exponential backtracking", () => {
  const previousText = `Intro \`code\`\n${"> ".repeat(40)}ordinary text`;
  const ownership = findCodeOwnership(previousText);

  expect(canReuseMarkdownOwnership(previousText, `${previousText}!`, ownership)).toBe(true);
});

it("keeps an unfinished reference title pending after a trailing escape", () => {
  const scenarios = [
    ['[id]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\\', 'a"'],
    ['[id]: /url\n    "title\n`x\n[tool:read] {}\nx` trailing\n', '"'],
  ] as const;

  for (const chunks of scenarios) {
    const source = chunks.join("");
    const stream = createAssistantVisibleStreamText("final_answer");

    expect(stream.append(chunks[0]).text).toContain("[tool:read] {}");
    const corrected = stream.append(chunks[1]);

    expect(corrected.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
    expect(corrected.text).not.toContain("[tool:read] {}");
  }
});

it("keeps a list-owned blockquote reference title pending until its quote closes", () => {
  const scenarios = [
    ['- item\n\n    > [id]: /url\n    > "title\n`x\n[tool:read] {}\nx` trailing\n    > ', '"\n'],
    ['- item\n\n\t> [id]: /url\n\t> "title\n`x\n[tool:read] {}\nx` trailing\n    > ', '"\n'],
  ] as const;

  for (const chunks of scenarios) {
    const source = chunks.join("");
    const stream = createAssistantVisibleStreamText("final_answer");

    expect(stream.append(chunks[0]).text).toContain("[tool:read] {}");

    const corrected = stream.append(chunks[1]);

    expect(corrected.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
    expect(corrected.text).not.toContain("[tool:read] {}");
  }
});

it("rechecks ownership when an indentation-only line gains content", () => {
  const chunks = ["[tool:read] {}\n\n    ", "[tool:write] {}\n"] as const;
  const source = chunks.join("");
  const stream = createAssistantVisibleStreamText("final_answer");

  stream.append(chunks[0]);
  const corrected = stream.append(chunks[1]);

  expect(corrected.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
  expect(corrected.text).toBe("    [tool:write] {}");
});

it("refreshes image-alt ownership when a long reference destination closes", () => {
  const nestedListContinuationReferencePrefix = [
    "![example `x\n[tool:read] {}\nx`][id]",
    "",
    "- level 1",
    "  - level 2",
    "    - level 3",
    "      - level 4",
    "        - level 5",
    "          - level 6",
    "            - level 7",
    "              - level 8",
    "",
    "                [id]: <./url",
  ].join("\n");
  const scenarios = [
    ["![example `x\n[tool:read] {}\nx`][id]\n\n[id]: <", "x".repeat(2_100), ">\n"],
    ["![example `x\n[tool:read] {}\nx`][a b c]\n\n[a\nb\nc]: <", `./${"x".repeat(2_100)}`, ">\n"],
    ["![example `x\n[tool:read] {}\nx`][id]\n\n- item\n\n    [id]: <./url", ">\n"],
    [nestedListContinuationReferencePrefix, ">\n"],
  ];

  for (const chunks of scenarios) {
    const source = chunks.join("");
    const stream = createAssistantVisibleStreamText("final_answer");

    for (const chunk of chunks.slice(0, -1)) {
      stream.append(chunk);
    }
    const corrected = stream.append(chunks.at(-1)!);

    expect(corrected.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
    expect(corrected.text).not.toContain("[tool:read] {}");
  }
});

it("does not extend a list fence across an unindented continuation", () => {
  const chunks = ["- ```text\n  [tool:read] {}\n  ~~~\n  example {}", "\n[tool:write] {}\nDone."];
  const source = chunks.join("");
  const stream = createAssistantVisibleStreamText("final_answer");

  for (const chunk of chunks) {
    stream.append(chunk);
  }

  expect(stream.text).toBe(sanitizeAssistantVisibleStreamText(source, "final_answer"));
  expect(stream.text).toContain("[tool:read] {}");
  expect(stream.text).not.toContain("[tool:write] {}");
});
