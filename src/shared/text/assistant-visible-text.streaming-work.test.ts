import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import * as toolCallRepair from "../../../packages/tool-call-repair/src/payload.js";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../../agents/embedded-agent-utils.js";
import { assistantVisibleTextFilters } from "./assistant-visible-text.js";
import { canReuseMarkdownOwnership, findCodeOwnership } from "./code-regions.js";
import { expectPrefixParity, regexWork, streamChunks } from "./streaming.test-support.js";
import { createTextProjection } from "./text-projection.js";

vi.mock("../../../packages/tool-call-repair/src/payload.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/tool-call-repair/src/payload.js")>();
  return {
    ...actual,
    projectPlainTextToolCallBlocks: vi.fn(actual.projectPlainTextToolCallBlocks),
  };
});

it.each([
  ["pretty-printed JSON", `{\n${'  {"id":0,"label":"ordinary value"},\n'.repeat(128)}}`],
  ["brace-heavy prose", 'Configure {"mode":"fast"} and continue. '.repeat(128)],
])("does not checkpoint ordinary %s", (_shape, input) => {
  const source = input.slice(0, 4096);
  const project = vi.mocked(toolCallRepair.projectPlainTextToolCallBlocks);
  project.mockClear();
  const stream = createAssistantVisibleStreamText("final_answer");
  for (let offset = 0; offset < source.length; offset += 4) {
    stream.append(source.slice(offset, offset + 4));
  }
  expect(stream.text).toBe(source.trimEnd());
  expect(project.mock.calls.length).toBe(0);
});

it("keeps a split tool header across an unbounded whitespace gap", () => {
  const chunks = ["Before\n[too", "l:write]", "\r\n" + " ".repeat(5000), '{"content":"ok"}\nDone.'];
  const stream = createAssistantVisibleStreamText("final_answer");
  for (const chunk of chunks) {
    stream.append(chunk);
  }
  expect(stream.text).toBe("Before\nDone.");
});

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
    findMarkdownCodeSpans(text: string) {
      // Its internal region call does not cross this module mock's export boundary.
      markdownOwnershipWork.scannedCharacters += text.length;
      return actual.findMarkdownCodeSpans(text);
    },
  };
});

function projectFinal(chunks: readonly string[]) {
  const stream = createAssistantVisibleStreamText("final_answer");
  for (const chunk of chunks) {
    stream.append(chunk);
  }
  expect(stream.text).toBe(sanitizeAssistantVisibleStreamText(chunks.join(""), "final_answer"));
  return stream.text;
}

function expectOwnershipCorrection(
  chunks: readonly string[],
  options: { visibleBefore?: boolean; intermediateVisible?: boolean; replaces?: boolean } = {},
) {
  const stream = createAssistantVisibleStreamText("final_answer");
  expect(
    stream.append(expectDefined(chunks[0], "initial chunk")).text.includes("[tool:read] {}"),
  ).toBe(options.visibleBefore ?? true);
  for (const chunk of chunks.slice(1, -1)) {
    stream.append(chunk);
    if (options.intermediateVisible) {
      expect(stream.text).toContain("[tool:read] {}");
    }
  }
  const corrected = stream.append(chunks.at(-1)!);
  if (options.replaces) {
    expect(corrected.delta).toBeNull();
  }
  expect(corrected.text).toBe(sanitizeAssistantVisibleStreamText(chunks.join(""), "final_answer"));
  expect(corrected.text.includes("[tool:read] {}")).toBe(!(options.visibleBefore ?? true));
  return corrected.text;
}

it.each(["mixed", "leading", "repeated literal", "repeated hidden"])(
  "bounds Markdown work for %s output",
  (shape) => {
    const mixed = Array.from(
      { length: 80 },
      (_, index) =>
        `Section ${index}: this explanation preserves literal examples while hiding unpublished steps.\n\n` +
        "```text\n[tool:read] {}\n<final>literal answer</final>\n<think>literal reasoning example</think>\n```\n\n" +
        "<think>private reasoning</think>\n\n" +
        "The visible answer continues after the example.\n\n",
    ).join("");
    const repeated =
      shape === "repeated literal"
        ? "```text\n<think>literal code</think>\n```\nOrdinary prose follows.\n\n"
        : '<think>hidden</think>\n```json\n{"ok":true}\n```\nOrdinary prose follows.\n\n';
    const source = shape.startsWith("repeated")
      ? `<final>${repeated.repeat(Math.ceil(22_000 / repeated.length))}</final>`
      : (shape === "leading" ? "\n\n" : "") + mixed;
    expect(source.length).toBeGreaterThanOrEqual(20_000);
    const stream = createAssistantVisibleStreamText("final_answer");
    let delivered = "";
    let scannedCharacters = 0;
    for (let offset = 0; offset < source.length; offset += 98) {
      const end = Math.min(offset + 98, source.length);
      const expected = sanitizeAssistantVisibleStreamText(source.slice(0, end), "final_answer");
      const before = markdownOwnershipWork.scannedCharacters;
      const result = stream.append(source.slice(offset, end));
      scannedCharacters += markdownOwnershipWork.scannedCharacters - before;
      delivered = result.delta === null ? result.text : delivered + result.delta;
      expect(result.text).toBe(expected);
      expect(delivered).toBe(expected);
    }
    if (!shape.startsWith("repeated")) {
      expect(stream.text).toContain("<think>literal reasoning example</think>");
      expect(stream.text).not.toContain("private reasoning");
    }
    expect(scannedCharacters).toBeLessThan(source.length * 16);
  },
);

it("restores provisional reasoning text and resets its state on replacement", () => {
  const stream = createAssistantVisibleStreamText("final_answer");
  const fenced =
    "<final>" +
    "```text\n<think>literal code</think>\n```\nOrdinary prose follows.\n\n".repeat(4) +
    "</final>";
  const scenarios = [
    ["<final\nx='a'>Answer\n", "next\n"],
    ["<final\nx='a", "'>Answer\n", "next\n"],
    ["<think\n/>Answer\n", "next\n"],
    ["</think\n>Answer\n", "next\n"],
    ["[x]: /u\n    <internal>private</internal>\n", "\n"],
    ["[x]: /u\n    <final>Answer</final>\n", "\n"],
    ["A\n\n", "`x </think> y", "`"],
    ["Answer <think>secret", "</think> done"],
    ["<thi", "<thi", "</internal>\n", "---\n", "\r"],
    Array.from({ length: Math.ceil(fenced.length / 98) }, (_, index) =>
      fenced.slice(index * 98, (index + 1) * 98),
    ),
  ];
  for (const chunks of scenarios) {
    stream.replace("");
    let source = "";
    let delivered = "";
    for (const chunk of chunks) {
      source += chunk;
      const result = stream.append(chunk);
      delivered = result.delta === null ? result.text : delivered + result.delta;
      const expected = sanitizeAssistantVisibleStreamText(source, "final_answer");
      expect(result.text).toBe(expected);
      expect(delivered).toBe(expected);
    }
  }
  expect(stream.replace("<think>new hidden</think>Fresh")).toEqual({
    text: "Fresh",
    delta: null,
  });
  expect(stream.append(" tail")).toEqual({ text: "Fresh tail", delta: " tail" });
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
  const testedCharacters = regexWork(() => streamChunks(source, 1, stream));
  expect(stream.text).toBe("");
  expect(testedCharacters).toBeGreaterThan(0);
  expect(testedCharacters).toBeLessThan(source.length * 128);
  expect(stream.append("Visible")).toEqual({ text: source + "Visible", delta: source + "Visible" });
  expect(stream.replace("\u2060")).toEqual({ text: "", delta: null });
});

const citedProse = "Answer with citation [1]. ".repeat(128) + "Done.";
it.each([
  ["open call", '[tool:write]\n{"path": "notes.txt", "content": "' + "x".repeat(4_096), true],
  ["cited answer", "[1]: https://example.test/reference\n```json\n{}\n```\n" + citedProse, false],
  ["blank title", '[1]: https://example.test/reference\n"unfinished\n\n' + citedProse, false],
  [
    "bibliography",
    Array.from({ length: 128 }, (_, i) => `[${i + 1}]: https://example.test/${i}`).join("\n") +
      "\n\n",
    false,
  ],
] as const)("bounds Markdown ownership work for %s", (_name, source, delivery) => {
  const stream = delivery
    ? createTextProjection(assistantVisibleTextFilters("delivery", true))
    : createAssistantVisibleStreamText("final_answer");
  const before = markdownOwnershipWork.scannedCharacters;
  streamChunks(source, 4, stream);
  expect(stream.text).toBe(
    _name === "bibliography" ? sanitizeAssistantVisibleStreamText(source, "final_answer") : source,
  );
  expect(markdownOwnershipWork.scannedCharacters - before).toBeLessThan(source.length * 16);
});

it.each([
  [
    "an open image description when its inline destination closes",
    "![example `x\n[tool:read] {}\nx` label",
    "](/url)\n",
  ],
  [
    "a multiline reference title when its closing quote arrives",
    '[id]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\n',
    '"',
  ],
  [
    "a reference image when its next-line destination arrives",
    "![example `x\n[tool:read] {}\nx`][id]\n\n[id]:\n",
    "/url\n",
  ],
])("recomputes final-answer ownership after %s", (_name, prefix, suffix) => {
  expect(expectOwnershipCorrection([prefix, suffix], { replaces: true })).not.toContain(
    "[tool:read]",
  );
});

it.each([
  ["[label](/url (title\n`x\n[tool:read] {}\nx` trailing\n", "))\n"],
  ["[label](/url (title\n`x\n[tool:read] {}\nx` trailing\n)", ")\n"],
  ["![example `x\n[tool:read] {}\nx`][id]\n\n> [id]:\n", "> /url\n"],
  ["![example `x\n[tool:read] {}\nx`][id]\n\n- [id]:\n", "  /url\n"],
  ['[label](/url "title\n`x\n[tool:read] {}\nx` trailing\n', '")\n'],
  ['[label](/u(x) "title\n`x\n[tool:read] {}\nx` trailing\n', '")\n'],
  ['[label](/u(x)\n"title\n`x\n[tool:read] {}\nx` trailing\n', '")\n'],
])(
  "refreshes ownership when streamed link and container syntax changes Markdown ownership",
  (...chunks: string[]) => {
    expectOwnershipCorrection(chunks, { replaces: true });
  },
);

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
  const final = expectPrefixParity(
    source,
    () => createAssistantVisibleStreamText("final_answer"),
    (text) => sanitizeAssistantVisibleStreamText(text, "final_answer"),
  );
  expect(final?.includes("[tool:read] {}")).toBe(source.startsWith("````"));
});

it.each([
  ["Intro `x\n[tool:read] {}\nx` | y\n", "--- ", "| ", "---", "\n"],
  ["Intro `x\n[tool:read] {}\nx` |\n---", ":\n"],
  ["Intro `x\n[tool:read] {}\nx` |\n --", ":\n"],
  ["Intro `x\n[tool:read] {}\nx` |\n -", ":\n"],
  ["Intro `x\n[tool:read] {}\nx` |\n:", "-\n"],
  ["Intro `x\n[tool:read] {}\nx` |\n:", "--\n"],
  ["Intro `x\n[tool:read] {}\nx` |   \n:", "-\n"],
])("rechecks ownership when a GFM table delimiter changes a paragraph", (...chunks: string[]) => {
  expectOwnershipCorrection(chunks);
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
    expectOwnershipCorrection([prefix, suffix], { visibleBefore: false });
  }
});

it("invalidates table ownership for a blockquoted delimiter row", () => {
  const prefix = "> Intro `x\n[tool:read] {}\n> x` |\n> ---:";
  const suffix = "x\n";
  expectOwnershipCorrection([prefix, suffix], { visibleBefore: false });
});

it.each(["> ", ">    > ", "> ".repeat(40), "- item\n\n    > "])(
  "refreshes link-title ownership across container prefixes %j",
  (opening) => {
    const continuation = opening.startsWith("-") ? "    > " : opening;
    expectOwnershipCorrection(
      [
        opening + '[label](/url "title\n`x\n[tool:read] {}\nx` trailing\n',
        continuation + '"\n' + continuation,
        ")\n",
      ],
      { intermediateVisible: true },
    );
  },
);

it("checks repeated blockquote prefixes without exponential backtracking", () => {
  const previousText = `Intro \`code\`\n${"> ".repeat(40)}ordinary text`;
  const ownership = findCodeOwnership(previousText);

  expect(canReuseMarkdownOwnership(previousText, `${previousText}!`, ownership)).toBe(true);
});

it.each([
  ['[id]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\\', 'a"'],
  ['[id]: /url\n    "title\n`x\n[tool:read] {}\nx` trailing\n', '"'],
])("keeps an unfinished reference title pending after a trailing escape", (...chunks: string[]) => {
  expectOwnershipCorrection(chunks);
});

it.each([
  ['- item\n\n    > [id]: /url\n    > "title\n`x\n[tool:read] {}\nx` trailing\n    > ', '"\n'],
  ['- item\n\n\t> [id]: /url\n\t> "title\n`x\n[tool:read] {}\nx` trailing\n    > ', '"\n'],
])(
  "keeps a list-owned blockquote reference title pending until its quote closes",
  (...chunks: string[]) => {
    expectOwnershipCorrection(chunks);
  },
);

it("rechecks ownership when an indentation-only line gains content", () => {
  const chunks = ["[tool:read] {}\n\n    ", "[tool:write] {}\n"] as const;
  expect(projectFinal(chunks)).toBe("    [tool:write] {}");
});

it("refreshes image-alt ownership when a long reference destination closes", () => {
  const nestedListContinuationReferencePrefix = [
    "![example `x\n[tool:read] {}\nx`][id]",
    "",
    ...Array.from({ length: 8 }, (_, i) => "  ".repeat(i) + `- level ${i + 1}`),
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
    expect(projectFinal(chunks)).not.toContain("[tool:read] {}");
  }
});

it("does not extend a list fence across an unindented continuation", () => {
  const chunks = ["- ```text\n  [tool:read] {}\n  ~~~\n  example {}", "\n[tool:write] {}\nDone."];
  const text = projectFinal(chunks);
  expect(text).toContain("[tool:read] {}");
  expect(text).not.toContain("[tool:write] {}");
});
