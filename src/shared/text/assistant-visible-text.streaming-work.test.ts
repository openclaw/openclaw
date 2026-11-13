import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type * as CodeRegions from "../../../packages/markdown-core/src/markdown-code-regions.js";
import type * as MarkdownParser from "../../../packages/markdown-core/src/reasoning-tag-parser.js";
import { userFacingTextFilters } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../../agents/embedded-agent-utils.js";
import { assistantVisibleTextFilters } from "./assistant-visible-text.js";
import { canReuseMarkdownOwnership, findCodeOwnership } from "./code-regions.js";
import { expectPrefixParity, regexWork, streamChunks } from "./streaming.test-support.js";
import { createTextProjection } from "./text-projection.js";

const settledProse =
  "The guard rejects the call when values differ.\nIt keeps the settled prefix.\n".repeat(128);

// `regexBudget` is the per-character bound on `regexWork`, which grows with the number of
// checkpoint stages that scan each settled line. Bracket rows keep one more active stage
// than the JSON/prose rows, so their bound is looser than the default.
it.each([
  ["pretty-printed JSON", `{\n${'  {"id":0,"label":"ordinary value"},\n'.repeat(128)}}`, 128],
  ["brace-heavy prose", 'Configure {"mode":"fast"} and continue. '.repeat(128), 128],
  // A closed legacy bracket block must let the preceding prefix settle instead of pinning the
  // whole reply; the looser `regexBudget` reflects the extra active checkpoint stage.
  ["legacy bracket block", "[TOOL_CALL]{}\n[/TOOL_CALL]\n" + settledProse, 512],
])("bounds ordinary %s streaming work", (_shape, input, regexBudget = 128) => {
  const source = input.slice(0, 4096);
  const stream = createAssistantVisibleStreamText("final_answer");
  const before = markdownOwnershipWork.scannedCharacters;
  const scanned = regexWork(() => streamChunks(source, 4, stream));
  expect(stream.text).toBe(source.trimEnd());
  expect(stream.settledLength).toBeGreaterThan(source.length * 0.9);
  expect(scanned).toBeLessThan(source.length * regexBudget);
  expect(markdownOwnershipWork.scannedCharacters - before).toBeLessThan(source.length * 16);
});

// A bare mention is not a real tag and must not latch the delivery filter.
it("keeps a bare relevant-memories mention off the whole-reply re-scan", () => {
  // regexWork counts characters fed to memories-relevant .test() calls; a bounded
  // total proves the probe scans a bounded tail instead of the growing reply.
  const source = "The relevant-memories feature stays off the hot path.\n\n"
    .repeat(64)
    .slice(0, 4096);
  const scanned = regexWork(
    () => {
      const stream = createAssistantVisibleStreamText("final_answer");
      streamChunks(source, 4, stream);
      expect(stream.text).toContain("relevant-memories feature");
    },
    (re) => String(re).includes("relevant") && /memor/i.test(String(re)),
  );
  expect(scanned).toBeLessThan(source.length * 8);
});

// A real ``<relevant-memories>`` tag still gates on and is stripped exactly once.
it("strips a real relevant-memories tag when it appears", () => {
  const source = "Intro.\n\n<relevant-memories>\nsecret\n</relevant-memories>\n\nAfter.\n";
  const stream = createAssistantVisibleStreamText("final_answer");
  streamChunks(source, 4, stream);
  expect(stream.text).not.toContain("secret");
  expect(stream.text).toContain("Intro.");
  expect(stream.text).toContain("After.");
});

// The canonical parser accepts whitespace after ``<`` and around ``/``; the probe
// must match, even when the tag word is split across deltas.
it("strips whitespace-tolerant relevant-memories tags split across deltas", () => {
  const source = "Before.\n\n< relevant-memories>\nsecret\n< / relevant_memories>\n\nAfter.\n";
  const stream = createAssistantVisibleStreamText("final_answer");
  streamChunks(source, 3, stream);
  expect(stream.text).not.toContain("secret");
  expect(stream.text).toContain("Before.");
  expect(stream.text).toContain("After.");
});

// An unbounded whitespace run between ``<`` and the tag word still gates the stage.
// ``< / word>`` shapes are closers in the canonical regex, so the opener omits ``/``.
it("strips a relevant-memories tag behind an unbounded whitespace gap", () => {
  const chunks = [
    "Before.\n\n<",
    " ".repeat(4096),
    "relevant-",
    "memories>\nsecret\n</",
    " ".repeat(2048),
    "relevant_memories>\n\nAfter.\n",
  ];
  const stream = createAssistantVisibleStreamText("final_answer");
  chunks.forEach((chunk) => stream.append(chunk));
  expect(stream.text).not.toContain("secret");
  expect(stream.text).toContain("Before.");
  expect(stream.text).toContain("After.");
});

// A whitespace run split across many appends must not push ``<`` out of the tail.
// The unclosed block hides everything after its opener, so assert batch parity too.
it("strips a memory tag behind many single-space deltas", () => {
  const chunks = ["Before.\n<", ...Array<string>(64).fill(" "), "relevant-memories>secret\nDone."];
  const stream = createAssistantVisibleStreamText("final_answer");
  chunks.forEach((chunk) => stream.append(chunk));
  expect(stream.text).not.toContain("secret");
  expect(stream.text).toBe(sanitizeAssistantVisibleStreamText(chunks.join(""), "final_answer"));
});

// Same gate for the minimax stage: a bare ``minimax:tool_call`` mention must not latch
// the whole-reply re-scan either.
it("keeps a bare minimax:tool_call mention off the whole-reply re-scan", () => {
  const source = "The minimax:tool_call feature stays off the hot path.\n\n"
    .repeat(64)
    .slice(0, 4096);
  const stream = createAssistantVisibleStreamText("final_answer");
  markdownOwnershipWork.scannedCharacters = 0;
  streamChunks(source, 4, stream);
  const md = markdownOwnershipWork.scannedCharacters;
  expect(stream.text).toContain("minimax:tool_call feature");
  expect(md).toBe(0);
});

// The canonical transform also strips a completed <invoke> block when the marker
// occurs without an exact envelope token. Batch/streaming parity must hold for every
// delta split; a bare mention (asserted above) must still not latch the stage.
it("strips a completed invoke block without an exact minimax envelope", () => {
  const source =
    'Ready.\n<minimax:tool_call >\n<invoke name="exec">secret</invoke>\n</minimax:tool_call >\nDone.';
  expectPrefixParity(
    source,
    () => createAssistantVisibleStreamText("final_answer"),
    (text) => sanitizeAssistantVisibleStreamText(text, "final_answer"),
  );
  expect(sanitizeAssistantVisibleStreamText(source, "final_answer")).not.toContain("secret");
});

// The canonical transform needs its marker anywhere in the text, so an invocation
// shape may arrive before the marker and must still be remembered.
it("strips an invoke block whose minimax marker arrives later", () => {
  const chunks = [
    'Ready.\n<invoke name="exec">secret</invoke>\n',
    "x".repeat(64),
    "\nminimax:tool_call\nDone.",
  ];
  const stream = createAssistantVisibleStreamText("final_answer");
  chunks.forEach((chunk) => stream.append(chunk));
  expect(stream.text).not.toContain("secret");
  expect(stream.text).toBe(sanitizeAssistantVisibleStreamText(chunks.join(""), "final_answer"));
});

it("keeps a split tool header across an unbounded whitespace gap", () => {
  const chunks = ["Before\n[too", "l:write]", "\r\n" + " ".repeat(5000), '{"content":"ok"}\nDone.'];
  const stream = createAssistantVisibleStreamText("final_answer");
  chunks.forEach((chunk) => stream.append(chunk));
  expect(stream.text).toBe("Before\nDone.");
});

const markdownOwnershipWork = vi.hoisted(() => ({ scannedCharacters: 0 }));

vi.mock("../../../packages/markdown-core/src/reasoning-tag-parser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof MarkdownParser>();
  return {
    ...actual,
    parseMarkdownOwnership(...args: Parameters<typeof actual.parseMarkdownOwnership>) {
      markdownOwnershipWork.scannedCharacters += args[0].length;
      return actual.parseMarkdownOwnership(...args);
    },
    findMarkdownCodeRegions(text: string) {
      markdownOwnershipWork.scannedCharacters += text.length;
      return actual.findMarkdownCodeRegions(text);
    },
  };
});

vi.mock("../../../packages/markdown-core/src/markdown-code-regions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CodeRegions>();
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

it.each([
  ["Ready.", 2, ""],
  [
    "Routing uses `channelId` and `agentId` so the reply lands in the right conversation and thread.",
    128,
    "",
  ],
  ["Read [guide](https://example.test/guide) for the exact instructions.", 128, ""],
  ["Read [guide](https://example.test/guide) and `code` for instructions.", 2, ""],
  ["repeat", 2, "```text\ninside\n\ninside\n```\n\n"],
] as const)("bounds duplicate paragraph work %#: %j", (paragraph, copies, prefix) => {
  const tail = prefix
    ? ["tail"]
    : Array.from(
        { length: 128 },
        (_, index) => `Paragraph ${index}: an ordinary explanatory sentence without code.`,
      );
  const source = prefix + [...Array<string>(copies).fill(paragraph), ...tail].join("\n\n");
  const stream = createAssistantVisibleStreamText("final_answer");
  markdownOwnershipWork.scannedCharacters = 0;
  const result = streamChunks(source, 4, stream);
  expect(result.text).toBe(prefix + [paragraph, ...tail].join("\n\n"));
  expect(result.delivered).toBe(result.text);
  expect(markdownOwnershipWork.scannedCharacters).toBeLessThan(source.length * 16);
  const parsed = markdownOwnershipWork.scannedCharacters;
  const continuation = Array.from({ length: 256 }, (_, index) => `-${index}`);
  for (const delta of continuation) {
    expect(stream.append(delta).delta).toBe(delta);
  }
  expect(markdownOwnershipWork.scannedCharacters).toBe(parsed);
  expect(stream.text).toBe(result.text + continuation.join(""));
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

it.each([
  ["- ```text\n  [tool:read] {}\n  ~~~\n  example {}", "\n[tool:write] {}\nDone."],
  ["> ```text\n> [Historical context: example]", "\n\n[Historical context: hidden]\nDone."],
  ["- ```text\n  [Historical context: example]", "\n\n[Historical context: hidden]\nDone."],
])("does not extend a container fence across its exit: %j", (...chunks) => {
  const text = projectFinal(chunks);
  expect(text).toContain(chunks[0]);
  expect(text).toContain("Done.");
  expect(text).not.toContain("[Historical context: hidden]");
  expect(text).not.toContain("[tool:write] {}");
});

const create = () => createAssistantVisibleStreamText("final_answer");
const batch = (source: string) =>
  sanitizeAssistantVisibleStreamText(source, "final_answer").trimEnd();

it.each([
  'Use `[TOOL_CALL]` and `[Tool Call: read]` literally.\n\n```\nhello [TOOL_CALL] tool => "read", args => {}\n[/TOOL_CALL]\n```\n\nLater `see [Tool Call: read (ID: 2)] here` continues.',
  "![alt `[Tool Call: read]`](url)",
  "[x](<url `[Tool Call: read (ID: 1)]`xxxx>)\n[x]( <url `[Tool Call: read (ID: 1)]`xxxx>)\n\n> [x](\n> <url `[Tool Call: read (ID: 1)]`xxxx>)\n\nDone.",
  "[Tool Call: read]```text\n\nordinary paragraph\n\n[Historical context: literal]\n",
  "[Tool Call: read]> ```text\n> [Historical context: literal]\n\nDone.",
  '[link](url "see `[Tool Call: read]` here")',
  '[TOOL_CALL] tool => "read", args => {\n"x": 1}[/TOOL_CALL]\nDone.',
  "[Tool Call: read]\nArguments: {\n}\n[Historical context: hidden]\nDone.",
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

it.each(["fenced", "indented", "lazy", "prefixed", "inline", "paragraph", "legacy", "downgraded"])(
  "bounds %s transcript work",
  (shape) => {
    const prefix = shape === "indented" ? "    " : shape === "prefixed" ? "> " : "";
    const opening = shape === "fenced" ? "```text\n" : shape === "lazy" ? "> $ build\n" : "";
    const newline =
      shape === "paragraph" ? "" : ["legacy", "downgraded"].includes(shape) ? "\n\n" : "\n";
    const line =
      shape === "inline" || shape === "paragraph"
        ? `The command produced (no output).${newline}${newline}`
        : `${prefix}(no output)\n`;
    const transcript =
      shape === "legacy"
        ? '```text\n[TOOL_CALL] tool => "read", args => {}[/TOOL_CALL]\n[TOOL_RESULT\n```\n'
        : shape === "downgraded"
          ? "`[Tool Call: read]` and `[Historical context: example]`\n```text\n[Tool Call\n[Tool Result\n[Historical context\n```\n"
          : "";
    const tail = Array.from(
      { length: 256 },
      (_, index) => `${prefix}Log record ${index}${transcript && " `code`"}.${newline}`,
    ).join("");
    const source = (transcript + opening + line + tail).slice(0, 4096);
    for (const size of transcript ? [4] : [1, 4]) {
      let previous = Infinity;
      for (const text of [source.slice(0, 2048), source]) {
        const stream = create();
        let delivered = "";
        const before = markdownOwnershipWork.scannedCharacters;
        const scanned = regexWork(() => {
          delivered = streamChunks(text, size, stream).delivered;
        });
        expect([stream.text, delivered]).toEqual([batch(text), batch(text)]);
        // Tool transcripts exercise every canonical pass with inline code in the tail.
        const budget = transcript ? 384 : 192;
        expect(scanned).toBeLessThan(text.length * budget);
        const parsed = markdownOwnershipWork.scannedCharacters - before;
        expect(parsed).toBeLessThan(text.length * (transcript ? 64 : 32));
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
