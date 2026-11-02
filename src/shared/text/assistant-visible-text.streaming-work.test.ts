import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import * as toolCallRepair from "../../../packages/tool-call-repair/src/payload.js";
import { userFacingTextFilters } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
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
  streamChunks(source, 4, stream);
  expect(stream.text).toBe(source.trimEnd());
  expect(project.mock.calls.length).toBe(0);
});

it("keeps a split tool header across an unbounded whitespace gap", () => {
  const chunks = ["Before\n[too", "l:write]", "\r\n" + " ".repeat(5000), '{"content":"ok"}\nDone.'];
  const stream = createAssistantVisibleStreamText("final_answer");
  chunks.forEach((chunk) => stream.append(chunk));
  expect(stream.text).toBe("Before\nDone.");
});

const markdownOwnershipWork = vi.hoisted(() => ({ scannedCharacters: 0 }));

vi.mock("./code-regions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./code-regions.js")>();
  return {
    ...actual,
    findCodeRegions(text: string) {
      markdownOwnershipWork.scannedCharacters += text.length;
      return actual.findCodeRegions(text);
    },
    findCodeOwnership(...args: Parameters<typeof actual.findCodeOwnership>) {
      markdownOwnershipWork.scannedCharacters += args[0].length;
      return actual.findCodeOwnership(...args);
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
  chunks.forEach((chunk) => stream.append(chunk));
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

it("bounds Markdown scan work after an early duplicate paragraph", () => {
  const paragraphs = Array.from(
    { length: 128 },
    (_, index) => `Paragraph ${index}: an ordinary explanatory sentence without code.`,
  );
  const source = ["Ready.", "Ready.", ...paragraphs].join("\n\n");
  const stream = createAssistantVisibleStreamText("final_answer");
  markdownOwnershipWork.scannedCharacters = 0;
  const result = streamChunks(source, 4, stream);
  expect(result.text).toBe(["Ready.", ...paragraphs].join("\n\n"));
  expect(result.delivered).toBe(result.text);
  expect(markdownOwnershipWork.scannedCharacters).toBeLessThan(source.length * 16);
});

it("restores provisional reasoning text and resets its state on replacement", () => {
  const stream = createAssistantVisibleStreamText("final_answer");
  const fenced =
    "<final>" +
    "```text\n<think>literal code</think>\n```\nOrdinary prose follows.\n\n".repeat(4) +
    "</final>";
  for (const chunks of [
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
  ]) {
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
    delivered = streamChunks(source, 4, stream).delivered;
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
  const visible = "\uDB40\uDC67Answer";
  expect(stream.append("Answer")).toEqual({ text: visible, delta: visible });
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
  ["![example `x\n[tool:read] {}\nx` label", "](/url)\n"],
  ['[id]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\n', '"'],
  ["![example `x\n[tool:read] {}\nx`][id]\n\n[id]:\n", "/url\n"],
  ["[label](/url (title\n`x\n[tool:read] {}\nx` trailing\n", "))\n"],
  ["[label](/url (title\n`x\n[tool:read] {}\nx` trailing\n)", ")\n"],
  ["![example `x\n[tool:read] {}\nx`][id]\n\n> [id]:\n", "> /url\n"],
  ["![example `x\n[tool:read] {}\nx`][id]\n\n- [id]:\n", "  /url\n"],
  ['[label](/url "title\n`x\n[tool:read] {}\nx` trailing\n', '")\n'],
  ['[label](/u(x) "title\n`x\n[tool:read] {}\nx` trailing\n', '")\n'],
  ['[label](/u(x)\n"title\n`x\n[tool:read] {}\nx` trailing\n', '")\n'],
])("replaces provisional code when image, link or reference ownership closes: %j", (...chunks) => {
  expect(expectOwnershipCorrection(chunks, { replaces: true })).not.toContain("[tool:read]");
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

it.each([
  ...["---:", "-:", "--:", ":-", ":--"].map(
    (delimiter) => `Intro \`x\n[tool:read] {}\nx\` |\n${delimiter}`,
  ),
  "Intro `x\n[tool:read] {}\nx`\n---:",
  "> Intro `x\n[tool:read] {}\n> x` |\n> ---:",
])("invalidates GFM table ownership when a delimiter gains text: %j", (prefix) => {
  expectOwnershipCorrection([prefix, "x\n"], { visibleBefore: false });
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
  ['- item\n\n    > [id]: /url\n    > "title\n`x\n[tool:read] {}\nx` trailing\n    > ', '"\n'],
  ['- item\n\n\t> [id]: /url\n\t> "title\n`x\n[tool:read] {}\nx` trailing\n    > ', '"\n'],
])("keeps escaped, indented and list-owned reference titles pending: %j", (...chunks) => {
  expectOwnershipCorrection(chunks);
});

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
  for (const chunks of [
    ["![example `x\n[tool:read] {}\nx`][id]\n\n[id]: <", "x".repeat(2_100), ">\n"],
    ["![example `x\n[tool:read] {}\nx`][a b c]\n\n[a\nb\nc]: <", `./${"x".repeat(2_100)}`, ">\n"],
    ["![example `x\n[tool:read] {}\nx`][id]\n\n- item\n\n    [id]: <./url", ">\n"],
    [nestedListContinuationReferencePrefix, ">\n"],
  ]) {
    expect(projectFinal(chunks)).not.toContain("[tool:read] {}");
  }
});

it("does not extend a list fence across an unindented continuation", () => {
  const chunks = ["- ```text\n  [tool:read] {}\n  ~~~\n  example {}", "\n[tool:write] {}\nDone."];
  const text = projectFinal(chunks);
  expect(text).toContain("[tool:read] {}");
  expect(text).not.toContain("[tool:write] {}");
});

const create = () => createAssistantVisibleStreamText("final_answer");
const batch = (source: string) =>
  sanitizeAssistantVisibleStreamText(source, "final_answer").trimEnd();

it.each([
  "$ build\n(no output)\n\nDone",
  "$ build\n   (no output)   \n\nDone",
  "Step\n[tool calls omitted]\n\nDone",
  "```text\n$ build\n(no output)\n```\n\nDone",
  "Example:\n\n    (no output)\n    step\n\nDone",
  "$ build\r\n(no output)\r\n\r\nDone",
  "- Step\n- (no output)\n\nDone",
  "The command produced (no output) and exited.",
  "(no output)\n(no output)\n\n[tool calls omitted]\n(no output)",
  "> $ build\n> (no output)\n> Explanation\n",
  "> $ build\n(no output)\n> Explanation\n",
  "Earlier\r\n[tool calls omitted]\r\n\r\nDone",
  ...[
    "\n\nDone",
    "\n>\n    (no output)",
    "\n```\n(no output)\n```",
    "\n# Heading",
    "\n- Item",
    "\n===",
    "\n![label `code\n(no output)\ncode`][id]\n\n[id]: /url",
  ].map((tail) => "> $ build\n(no output)\n[tool calls omitted]\n" + tail),
  "> `open\n(no output)\nclose`",
  "> ![open\n(no output)\n`code`][id]\n\n[id]: /url",
  ...['"', "'"].flatMap((quote) => [
    `> [label](/url ${quote}\n(no output)\n\`code\n(no output)\ncode\`\n${quote})\n`,
    `> ![label](/url ${quote}\n(no output)\n\`code\n(no output)\ncode\`\n${quote})\n`,
  ]),
  ...['"', "'", "("].map(
    (quote) =>
      `(no output)\n\n> [id]: /url ${quote}title\n> continued\n> \`x\n> ${quote === "(" ? ")" : quote}\n(no output)\nx\``,
  ),
])("preserves batch output through every split: %j", (source) => {
  expectPrefixParity(source, create, batch);
});

it.each(["fenced", "indented", "lazy", "prefixed", "inline", "paragraph"])(
  "bounds %s transcript work",
  (shape) => {
    const prefix = shape === "indented" ? "    " : shape === "prefixed" ? "> " : "";
    const opening = shape === "fenced" ? "```text\n" : shape === "lazy" ? "> $ build\n" : "";
    const newline = shape === "paragraph" ? "" : "\n";
    const line =
      shape === "inline" || shape === "paragraph"
        ? `The command produced (no output).${newline}${newline}`
        : `${prefix}(no output)\n`;
    const tail = `${prefix}Unique log record.${newline}`.repeat(256);
    const source = (opening + line + tail).slice(0, 4096);
    for (const size of [1, 4]) {
      let previous = Infinity;
      for (const text of [source.slice(0, 2048), source]) {
        const stream = create();
        let delivered = "";
        const scanned = regexWork(() => {
          delivered = streamChunks(text, size, stream).delivered;
        });
        expect([stream.text, delivered]).toEqual([batch(text), batch(text)]);
        // This counts whole-path regexp work, not only placeholder-stage characters.
        expect(scanned).toBeLessThan(text.length * 192);
        expect(scanned).toBeLessThanOrEqual(previous * 2.25);
        previous = scanned;
      }
    }
  },
);

it("preserves replacement, split CRLF and late activation boundaries", () => {
  for (const replacement of ["Intro.\n\n$ build\n(no output)\n\nTail", "Intro.\n\n(no out"]) {
    const stream = create();
    stream.append("Intro without a placeholder.");
    stream.replace(replacement);
    stream.append("put)\n\nDone.");
    expect(stream.text, replacement).toBe(batch(replacement + "put)\n\nDone."));
  }
  const source = "Earlier step.\n\n".repeat(512) + "```\n(no output)\n```\n\nDone.";
  expect(streamChunks(source, 4, create()).text).toBe(batch(source));
  const direct = createTextProjection(userFacingTextFilters(false, true));
  expect(direct.append("[tool calls omitted]\r").text).toBe("[tool calls omitted]\r");
  expect(direct.append("\nDone").text).toBe("Done");
});
