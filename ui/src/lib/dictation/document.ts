import {
  ambiguousDictationMarker,
  dictationLiteralRanges,
  dictationMarkerCandidates,
  ordinaryDictationMarker,
} from "./grammar.ts";
import {
  DICTATION_FORMATTING_LIMITS as LIMITS,
  type DictationBlock,
  type DictationConsumedMarker,
  type DictationDocument,
  type DictationDocumentCounts,
  type DictationList,
  type DictationMarkerReason,
  type DictationRange,
  type DictationRun,
} from "./types.ts";

const numberWords = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];
const markerReasons: Readonly<Record<string, DictationMarkerReason>> = {
  "new paragraph": "paragraph-break",
  "new line": "line-break",
  bullet: "bullet",
  "next item": "next-item",
  "start list": "list-start",
  "nested list": "nested-list",
  "end list": "list-end",
};

/** Independent validation of a marker claim: arbitrary text cannot claim a reason. */
export function readDictationMarker(text: string):
  | {
      reason: DictationMarkerReason;
      ordinal?: number;
    }
  | undefined {
  const phrase = text
    .toLowerCase()
    .replace(/[,:.]$/, "")
    .replace(/[ \t]+/g, " ");
  if (Object.hasOwn(markerReasons, phrase)) {
    return { reason: markerReasons[phrase]! };
  }
  if (!phrase.startsWith("step ")) {
    return undefined;
  }
  const number = phrase.slice(5);
  const ordinal = /^(?:0|[1-9]\d{0,8})$/.test(number)
    ? Number(number)
    : numberWords.indexOf(number);
  return ordinal >= 0 ? { reason: "numbered-item", ordinal } : undefined;
}

export function isBoundedDictationText(text: string): boolean {
  return (
    text.length <= LIMITS.textBytes && new TextEncoder().encode(text).length <= LIMITS.textBytes
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function range(value: unknown, text: string, boundaries: Set<number>): value is DictationRange {
  return (
    record(value) &&
    exactKeys(value, ["start", "end"]) &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    value.start >= 0 &&
    value.start < value.end &&
    value.end <= text.length &&
    boundaries.has(value.start) &&
    boundaries.has(value.end)
  );
}

export type DictationValidationResult =
  | { ok: true; document: DictationDocument; counts: DictationDocumentCounts }
  | { ok: false; reason: string };

/** The only trust boundary for semantic documents. Traversal is bounded before recursion. */
export function validateDictationDocument(value: unknown): DictationValidationResult {
  if (
    !record(value) ||
    !exactKeys(value, [
      "version",
      "mode",
      "source",
      "protectedRanges",
      "blocks",
      "consumedMarkers",
      "confirmedMarkers",
    ]) ||
    value.version !== 1 ||
    (value.mode !== "preserve" && value.mode !== "explicit") ||
    !record(value.source) ||
    !exactKeys(value.source, ["id", "revision", "text"]) ||
    typeof value.source.id !== "string" ||
    !value.source.id ||
    value.source.id.length > 256 ||
    typeof value.source.revision !== "number" ||
    !Number.isSafeInteger(value.source.revision) ||
    value.source.revision < 0 ||
    typeof value.source.text !== "string" ||
    !isBoundedDictationText(value.source.text)
  ) {
    return { ok: false, reason: "invalid-source-or-version" };
  }
  const text = value.source.text;
  const mode = value.mode;
  // Browser HTML parsing cannot faithfully represent NUL or unpaired surrogates.
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) {
      return { ok: false, reason: "invalid-unicode" };
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return { ok: false, reason: "invalid-unicode" };
      }
    }
  }
  const boundaries = new Set<number>([text.length]);
  for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    boundaries.add(segment.index);
  }
  if (
    !Array.isArray(value.protectedRanges) ||
    value.protectedRanges.length > LIMITS.protectedRanges ||
    !Array.isArray(value.consumedMarkers) ||
    value.consumedMarkers.length > LIMITS.markers ||
    !Array.isArray(value.blocks) ||
    value.blocks.length > LIMITS.blocks ||
    !Array.isArray(value.confirmedMarkers) ||
    value.confirmedMarkers.length > LIMITS.confirmationCandidates
  ) {
    return { ok: false, reason: "document-limit" };
  }
  const suppliedRanges: DictationRange[] = [];
  for (const item of value.protectedRanges) {
    if (!range(item, text, boundaries) || item.start < (suppliedRanges.at(-1)?.end ?? 0)) {
      return { ok: false, reason: "invalid-protected-range" };
    }
    suppliedRanges.push({ start: item.start, end: item.end });
  }
  const protectedRanges: { start: number; end: number }[] = [];
  for (const item of [...suppliedRanges, ...dictationLiteralRanges(text)].toSorted(
    (left, right) => left.start - right.start,
  )) {
    let { start, end } = item;
    // Automatically recognized URLs/quotes can end beside a combining mark.
    // Expand protection; never split that grapheme or alter the source bytes.
    while (!boundaries.has(start) && start > 0) {
      start--;
    }
    while (!boundaries.has(end) && end < text.length) {
      end++;
    }
    const previous = protectedRanges.at(-1);
    if (previous && previous.end >= start) {
      previous.end = Math.max(previous.end, end);
    } else {
      protectedRanges.push({ start, end });
    }
  }
  if (protectedRanges.length > LIMITS.protectedRanges) {
    return { ok: false, reason: "protected-range-limit" };
  }
  const candidates = dictationMarkerCandidates(text, protectedRanges);
  const confirmedMarkers: DictationRange[] = [];
  for (const confirmed of value.confirmedMarkers) {
    if (
      !range(confirmed, text, boundaries) ||
      confirmed.start < (confirmedMarkers.at(-1)?.end ?? 0) ||
      !candidates?.some(
        (candidate) =>
          candidate.source.start === confirmed.start && candidate.source.end === confirmed.end,
      )
    ) {
      return { ok: false, reason: "invalid-marker-confirmation" };
    }
    confirmedMarkers.push({ start: confirmed.start, end: confirmed.end });
  }
  const markers = new Map<number, DictationConsumedMarker>();
  let previousEnd = 0;
  for (const raw of value.consumedMarkers) {
    if (
      !record(raw) ||
      !exactKeys(raw, ["source", "reason", "ordinal"]) ||
      !range(raw.source, text, boundaries)
    ) {
      return { ok: false, reason: "invalid-marker-range" };
    }
    const source = raw.source;
    if (
      source.start < previousEnd ||
      protectedRanges.some((item) => item.start < source.end && item.end > source.start)
    ) {
      return { ok: false, reason: "invalid-marker-range" };
    }
    const expected = readDictationMarker(text.slice(source.start, source.end));
    if (!expected || expected.reason !== raw.reason || expected.ordinal !== raw.ordinal) {
      return { ok: false, reason: "invalid-marker-reason" };
    }
    if (
      ordinaryDictationMarker(text, source) ||
      (ambiguousDictationMarker(text, source) &&
        !confirmedMarkers.some(
          (confirmed) => confirmed.start === source.start && confirmed.end === source.end,
        ))
    ) {
      return { ok: false, reason: "ambiguous-marker-consumption" };
    }
    markers.set(source.start, { source, ...expected });
    previousEnd = source.end;
  }
  if (
    confirmedMarkers.some((confirmed) => markers.get(confirmed.start)?.source.end !== confirmed.end)
  ) {
    return { ok: false, reason: "unused-marker-confirmation" };
  }
  if (mode === "preserve" && (markers.size || confirmedMarkers.length)) {
    return { ok: false, reason: "preserve-consumed-content" };
  }
  let cursor = 0;
  let runCount = 0;
  const usedMarkers = new Set<number>();
  const seen = new Set<object>();
  const counts = { blocks: 0, items: 0, depth: 0 };
  const blocks: DictationBlock[] = [];
  let failure = "invalid-structure";
  function retainedGap(start: number, end: number): boolean {
    return (
      /\S/u.test(text.slice(start, end)) ||
      protectedRanges.some((item) => item.start < end && item.end > start)
    );
  }
  function enter(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
    if (!record(raw) || seen.has(raw) || !exactKeys(raw, keys)) {
      failure = "unknown-or-repeated-node";
      return false;
    }
    seen.add(raw);
    return true;
  }
  function visitRange(
    raw: unknown,
    reasons?: readonly DictationMarkerReason[],
  ): DictationRange | undefined {
    if (!range(raw, text, boundaries) || raw.start < cursor || retainedGap(cursor, raw.start)) {
      failure = "lost-reordered-or-duplicate-content";
      return undefined;
    }
    const marker = markers.get(raw.start);
    if (reasons) {
      if (
        !marker ||
        marker.source.end !== raw.end ||
        !reasons.includes(marker.reason) ||
        usedMarkers.has(raw.start)
      ) {
        failure = "unowned-marker";
        return undefined;
      }
      usedMarkers.add(raw.start);
    } else if (
      (raw.start > 0 && /\S/u.test(text[raw.start - 1]!) && /\S/u.test(text[raw.start]!)) ||
      (raw.end < text.length && /\S/u.test(text[raw.end - 1]!) && /\S/u.test(text[raw.end]!))
    ) {
      failure = "split-lexical-content";
      return undefined;
    }
    cursor = raw.end;
    return { start: raw.start, end: raw.end };
  }
  function runs(raw: unknown): DictationRun[] | undefined {
    if (!Array.isArray(raw) || !raw.length || raw.length > LIMITS.runs) {
      return undefined;
    }
    const result: DictationRun[] = [];
    for (const entry of raw) {
      if (
        ++runCount > LIMITS.runs ||
        !enter(entry, ["type", "source"]) ||
        (entry.type !== "text" && entry.type !== "line-break")
      ) {
        return undefined;
      }
      const source = visitRange(
        entry.source,
        entry.type === "line-break" ? ["line-break"] : undefined,
      );
      if (!source || (entry.type === "text" && !/\S/u.test(text.slice(source.start, source.end)))) {
        return undefined;
      }
      const previous = result.at(-1);
      if (
        entry.type === "text" &&
        previous?.type === "text" &&
        previous.source.end !== source.start
      ) {
        failure = "lost-inter-run-whitespace";
        return undefined;
      }
      result.push({ type: entry.type, source });
    }
    if (result[0]?.type !== "text" || result.at(-1)?.type !== "text") {
      return undefined;
    }
    return result;
  }
  function block(raw: unknown, depth: number): DictationBlock | undefined {
    if (
      ++counts.blocks > LIMITS.blocks ||
      depth > LIMITS.depth ||
      !enter(raw, ["type", "runs", "marker", "ordered", "items", "endMarker"])
    ) {
      return undefined;
    }
    if (raw.type === "paragraph" && depth === 0 && exactKeys(raw, ["type", "runs", "marker"])) {
      if (raw.marker === undefined && blocks.length) {
        const first = Array.isArray(raw.runs) ? raw.runs[0] : undefined;
        if (!record(first) || !range(first.source, text, boundaries)) {
          return undefined;
        }
        const gap = text.slice(cursor, first.source.start).replace(/\r\n|\r/g, "\n");
        const previous = blocks.at(-1);
        if (!/\n[ \t]*\n/.test(gap) && !(previous?.type === "list" && previous.endMarker)) {
          failure = "unapproved-paragraph-boundary";
          return undefined;
        }
      } else if (raw.marker !== undefined && !blocks.length) {
        failure = "empty-structure";
        return undefined;
      }
      const marker =
        raw.marker === undefined ? undefined : visitRange(raw.marker, ["paragraph-break"]);
      if (raw.marker !== undefined && !marker) {
        return undefined;
      }
      const content = runs(raw.runs);
      return content
        ? { type: "paragraph", runs: content, ...(marker ? { marker } : {}) }
        : undefined;
    }
    if (
      raw.type !== "list" ||
      mode !== "explicit" ||
      typeof raw.ordered !== "boolean" ||
      !exactKeys(raw, ["type", "ordered", "items", "marker", "endMarker"]) ||
      !Array.isArray(raw.items) ||
      !raw.items.length ||
      raw.items.length > LIMITS.items
    ) {
      return undefined;
    }
    const listDepth = depth + 1;
    if (listDepth > LIMITS.depth) {
      return undefined;
    }
    counts.depth = Math.max(counts.depth, listDepth);
    const marker =
      raw.marker === undefined
        ? undefined
        : visitRange(raw.marker, [depth ? "nested-list" : "list-start"]);
    if ((depth > 0 || raw.marker !== undefined) && !marker) {
      return undefined;
    }
    const items: DictationList["items"][number][] = [];
    for (const entry of raw.items) {
      if (
        ++counts.items > LIMITS.items ||
        !enter(entry, ["runs", "children", "marker", "ordinal"])
      ) {
        return undefined;
      }
      const itemMarker = visitRange(
        entry.marker,
        raw.ordered ? ["numbered-item", "next-item"] : ["bullet", "next-item"],
      );
      if (!itemMarker) {
        return undefined;
      }
      const claimed = markers.get(itemMarker.start)!;
      const ordinal = raw.ordered
        ? (claimed.ordinal ?? (items.at(-1)?.ordinal ?? -1) + 1)
        : undefined;
      if (
        entry.ordinal !== ordinal ||
        (raw.ordered &&
          (!Number.isSafeInteger(ordinal) || ordinal! < 0 || ordinal! > 999_999_999)) ||
        (claimed.reason === "next-item" && !items.length)
      ) {
        return undefined;
      }
      const content = runs(entry.runs);
      if (!content || !Array.isArray(entry.children) || entry.children.length > LIMITS.blocks) {
        return undefined;
      }
      const children: DictationList[] = [];
      for (const child of entry.children) {
        const nested = block(child, listDepth);
        if (!nested || nested.type !== "list") {
          return undefined;
        }
        children.push(nested);
      }
      items.push({
        runs: content,
        children,
        marker: itemMarker,
        ...(ordinal !== undefined ? { ordinal } : {}),
      });
    }
    const endMarker =
      raw.endMarker === undefined ? undefined : visitRange(raw.endMarker, ["list-end"]);
    if (raw.endMarker !== undefined && !endMarker) {
      return undefined;
    }
    return {
      type: "list",
      ordered: raw.ordered,
      items,
      ...(marker ? { marker } : {}),
      ...(endMarker ? { endMarker } : {}),
    };
  }
  for (const raw of value.blocks) {
    const parsed = block(raw, 0);
    if (!parsed) {
      return { ok: false, reason: failure };
    }
    blocks.push(parsed);
  }
  if (retainedGap(cursor, text.length) || usedMarkers.size !== markers.size) {
    return { ok: false, reason: "lost-content-or-unowned-marker" };
  }
  return {
    ok: true,
    document: {
      version: 1,
      mode,
      source: { id: value.source.id, revision: value.source.revision, text },
      protectedRanges,
      blocks,
      consumedMarkers: [...markers.values()],
      confirmedMarkers,
    },
    counts,
  };
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "\\$&")
    .replace(/\t/g, "&#9;")
    .replace(/^ +/gm, (spaces) => "&#32;".repeat(spaces.length))
    .replace(/ +(?=\r|\n|$)/g, (spaces) => "&#32;".repeat(spaces.length))
    .replace(/\r\n|\r|\n/g, "\\\n");
}

/** Only validated values enter serializers; none accepts generated markup or MIME types. */
export function renderDictationDocument(document: DictationDocument): {
  plainText: string;
  markdown: string;
  html: string;
} {
  function inline(runs: readonly DictationRun[], format: "plain" | "markdown" | "html"): string {
    return runs
      .map((run) => {
        if (run.type === "line-break") {
          return format === "html" ? "<br>" : format === "markdown" ? "\\\n" : "\n";
        }
        const text = document.source.text.slice(run.source.start, run.source.end);
        return format === "html"
          ? escapeHtml(text).replace(/\r\n|\r|\n/g, "<br>")
          : format === "markdown"
            ? escapeMarkdown(text)
            : text;
      })
      .join("");
  }
  function render(
    block: DictationBlock,
    format: "plain" | "markdown" | "html",
    plainIndent = "",
  ): string {
    if (block.type === "paragraph") {
      const content = inline(block.runs, format);
      return format === "html" ? `<p>${content}</p>` : content;
    }
    if (format === "html") {
      const tag = block.ordered ? "ol" : "ul";
      const start = block.ordered ? ` start="${block.items[0]!.ordinal}"` : "";
      return `<${tag}${start}>${block.items
        .map(
          (item) =>
            `<li${block.ordered ? ` value="${item.ordinal}"` : ""}>${inline(item.runs, format)}${item.children.map((child) => render(child, format)).join("")}</li>`,
        )
        .join("")}</${tag}>`;
    }
    if (format === "plain") {
      return block.items
        .map((item) => {
          const prefix = block.ordered ? `${item.ordinal}. ` : "- ";
          const children = item.children
            .map((child) => render(child, "plain", plainIndent + " ".repeat(prefix.length)))
            .join("\n");
          // Only structural markers receive indentation. Prefixing every physical
          // line would silently insert spaces into protected multiline literals.
          return `${plainIndent}${prefix}${inline(item.runs, "plain")}${children ? `\n${children}` : ""}`;
        })
        .join("\n");
    }
    let delimiter = ".";
    return block.items
      .map((item, index) => {
        // CommonMark ignores non-first item labels. A delimiter change starts a new
        // list, faithfully retaining repeated/skipped explicit numbers without HTML.
        const split =
          block.ordered && index > 0 && item.ordinal !== block.items[index - 1]!.ordinal! + 1;
        if (split) {
          delimiter = delimiter === "." ? ")" : ".";
        }
        const prefix = block.ordered ? `${item.ordinal}${delimiter} ` : "- ";
        const indent = " ".repeat(prefix.length);
        const content = inline(item.runs, format).replace(/\n/g, `\n${indent}`);
        const children = item.children
          .map((child) =>
            render(child, format)
              .split("\n")
              .map((line) => indent + line)
              .join("\n"),
          )
          .join("\n\n");
        return `${split ? "\n" : ""}${prefix}${content}${children ? `\n\n${children}` : ""}`;
      })
      .join("\n");
  }
  return {
    plainText:
      document.mode === "preserve"
        ? document.source.text
        : document.blocks.map((block) => render(block, "plain")).join("\n\n"),
    markdown: document.blocks.map((block) => render(block, "markdown")).join("\n\n"),
    html: document.blocks.map((block) => render(block, "html")).join(""),
  };
}
