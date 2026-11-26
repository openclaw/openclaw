import {
  isBoundedDictationText,
  readDictationMarker,
  renderDictationDocument,
  validateDictationDocument,
} from "./document.ts";
import {
  ambiguousDictationMarker,
  dictationMarkerCandidates,
  ordinaryDictationMarker,
} from "./grammar.ts";
import {
  DICTATION_FORMATTING_LIMITS as LIMITS,
  type DictationBlock,
  type DictationConsumedMarker,
  type DictationDocument,
  type DictationFormattingMode,
  type DictationFormattingOptions,
  type DictationFormattingResult,
  type DictationList,
  type DictationListItem,
  type DictationParagraph,
  type DictationRange,
  type DictationRun,
} from "./types.ts";

export * from "./types.ts";
export { renderDictationDocument, validateDictationDocument } from "./document.ts";

type MutableParagraph = { -readonly [Key in keyof DictationParagraph]: DictationParagraph[Key] } & {
  runs: DictationRun[];
};
type MutableItem = Omit<DictationListItem, "runs" | "children"> & {
  runs: DictationRun[];
  children: MutableList[];
};
type MutableList = Omit<DictationList, "items" | "endMarker"> & {
  items: MutableItem[];
  endMarker?: DictationRange;
};

function textRun(
  text: string,
  start: number,
  end: number,
  protectedRanges: readonly DictationRange[],
): DictationRun | undefined {
  const candidate = text.slice(start, end);
  const first = candidate.search(/\S/u);
  if (first < 0) {
    return undefined;
  }
  let retainedStart = start + first;
  let retainedEnd = start + candidate.trimEnd().length;
  for (const range of protectedRanges) {
    if (range.start < end && range.end > start) {
      retainedStart = Math.min(retainedStart, Math.max(start, range.start));
      retainedEnd = Math.max(retainedEnd, Math.min(end, range.end));
    }
  }
  return { type: "text", source: { start: retainedStart, end: retainedEnd } };
}

function preservedBlocks(
  text: string,
  protectedRanges: readonly DictationRange[],
): DictationBlock[] {
  const blocks: DictationBlock[] = [];
  let start = 0;
  for (const boundary of text.matchAll(/(?:\r?\n)[ \t]*(?:\r?\n)+/g)) {
    if (
      protectedRanges.some(
        (range) => range.start < boundary.index + boundary[0].length && range.end > boundary.index,
      )
    ) {
      continue;
    }
    if (/\S/u.test(text.slice(start, boundary.index))) {
      blocks.push({
        type: "paragraph",
        runs: [{ type: "text", source: { start, end: boundary.index } }],
      });
    }
    start = boundary.index + boundary[0].length;
  }
  if (/\S/u.test(text.slice(start))) {
    blocks.push({
      type: "paragraph",
      runs: [{ type: "text", source: { start, end: text.length } }],
    });
  }
  return blocks;
}

function explicitDocument(
  base: DictationDocument,
  confirmedMarkers: readonly DictationRange[],
): DictationDocument | string {
  const text = base.source.text;
  const pattern =
    /(?<![\p{L}\p{N}_])(?:new[ \t]+paragraph|new[ \t]+line|next[ \t]+item|start[ \t]+list|nested[ \t]+list|end[ \t]+list|bullet|step[ \t]+(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty))(?:[,:.])?(?=$|\s)/giu;
  const commands: DictationConsumedMarker[] = [];
  for (const match of text.matchAll(pattern)) {
    const source = { start: match.index, end: match.index + match[0].length };
    if (
      base.protectedRanges.some((range) => range.start < source.end && range.end > source.start)
    ) {
      continue;
    }
    if (
      ordinaryDictationMarker(text, source) ||
      (ambiguousDictationMarker(text, source) &&
        !confirmedMarkers.some((range) => range.start === source.start && range.end === source.end))
    ) {
      continue;
    }
    const marker = readDictationMarker(match[0]);
    if (!marker || commands.length >= LIMITS.markers) {
      return "unsupported-marker-or-limit";
    }
    commands.push({ source, ...marker });
  }
  if (!commands.length) {
    return base;
  }
  const blocks: (MutableParagraph | MutableList)[] = [];
  const stack: MutableList[] = [];
  let paragraph: MutableParagraph | undefined;
  let pendingParagraph: DictationRange | undefined;
  let pendingList: DictationConsumedMarker | undefined;
  let cursor = 0;
  const currentItem = () => stack.at(-1)?.items.at(-1);
  function append(end: number): boolean {
    const run = textRun(text, cursor, end, base.protectedRanges);
    if (!run) {
      return true;
    }
    if (pendingList) {
      return false;
    }
    const item = currentItem();
    if (item) {
      if (item.children.length) {
        return false;
      }
      item.runs.push(run);
    } else {
      if (!paragraph) {
        paragraph = {
          type: "paragraph",
          runs: [],
          ...(pendingParagraph ? { marker: pendingParagraph } : {}),
        };
        blocks.push(paragraph);
        pendingParagraph = undefined;
      }
      paragraph.runs.push(run);
    }
    return true;
  }
  for (const command of commands) {
    if (!append(command.source.start)) {
      return "ambiguous-structure";
    }
    const activeRuns = currentItem()?.runs ?? paragraph?.runs;
    switch (command.reason) {
      case "paragraph-break":
        if (!activeRuns?.length || pendingParagraph || pendingList) {
          return "empty-structure";
        }
        stack.length = 0;
        paragraph = undefined;
        pendingParagraph = command.source;
        break;
      case "line-break":
        if (!activeRuns?.length || activeRuns.at(-1)?.type !== "text" || pendingList) {
          return "empty-structure";
        }
        activeRuns.push({ type: "line-break", source: command.source });
        break;
      case "list-start":
      case "nested-list":
        if (
          pendingList ||
          pendingParagraph ||
          (command.reason === "nested-list" ? !currentItem()?.runs.length : stack.length > 0)
        ) {
          return "ambiguous-structure";
        }
        pendingList = command;
        break;
      case "list-end": {
        const list = stack.pop();
        if (!list || !list.items.at(-1)?.runs.length || pendingList) {
          return "empty-structure";
        }
        list.endMarker = command.source;
        paragraph = undefined;
        break;
      }
      case "bullet":
      case "numbered-item":
      case "next-item": {
        if (pendingParagraph) {
          return "ambiguous-structure";
        }
        let list = stack.at(-1);
        const ordered =
          command.reason === "numbered-item" ||
          (command.reason === "next-item" && Boolean(list?.ordered));
        if (command.reason === "next-item" && (!list?.items.length || pendingList)) {
          return "ambiguous-structure";
        }
        if (pendingList || !list || list.ordered !== ordered) {
          const created: MutableList = {
            type: "list",
            ordered,
            items: [],
            ...(pendingList ? { marker: pendingList.source } : {}),
          };
          if (pendingList?.reason === "nested-list") {
            currentItem()!.children.push(created);
          } else {
            stack.length = 0;
            blocks.push(created);
          }
          list = created;
          stack.push(list);
          pendingList = undefined;
          paragraph = undefined;
        }
        list.items.push({
          marker: command.source,
          runs: [],
          children: [],
          ...(ordered
            ? { ordinal: command.ordinal ?? (list.items.at(-1)?.ordinal ?? -1) + 1 }
            : {}),
        });
        if (
          stack.length > LIMITS.depth ||
          list.items.length > LIMITS.items ||
          blocks.length > LIMITS.blocks
        ) {
          return "document-limit";
        }
        break;
      }
    }
    cursor = command.source.end;
  }
  if (!append(text.length) || pendingParagraph || pendingList) {
    return "empty-structure";
  }
  return { ...base, mode: "explicit", blocks, consumedMarkers: commands, confirmedMarkers };
}

/** Pure, synchronous final-transcript preparation. The caller owns lifecycle and eligibility. */
export function prepareDictationFormatting(
  text: string,
  mode: DictationFormattingMode = "preserve",
  options: DictationFormattingOptions = {},
): DictationFormattingResult {
  const fallback = (reason: string): DictationFormattingResult => ({
    status: "raw-fallback",
    originalText: text,
    plainText: text,
    markdown: "",
    html: "",
    reason,
    counts: { blocks: 0, items: 0, depth: 0 },
    candidates: [],
  });
  if (!isBoundedDictationText(text)) {
    return fallback("text-limit");
  }
  if (mode !== "preserve" && mode !== "explicit") {
    return fallback("unsupported-mode");
  }
  // Validate supplied offsets independently before merging automatic protection;
  // a large enclosing quote must not conceal an invalid caller source map.
  const rawBase: DictationDocument = {
    version: 1,
    mode: "preserve",
    source: {
      id: options.sourceId ?? "local-final-transcript",
      revision: options.sourceRevision ?? 0,
      text,
    },
    protectedRanges: options.protectedRanges ?? [],
    blocks: /\S/u.test(text)
      ? [{ type: "paragraph", runs: [{ type: "text", source: { start: 0, end: text.length } }] }]
      : [],
    consumedMarkers: [],
    confirmedMarkers: [],
  };
  const checked = validateDictationDocument(rawBase);
  if (!checked.ok) {
    return fallback(checked.reason);
  }
  const base: DictationDocument = {
    ...checked.document,
    blocks: preservedBlocks(text, checked.document.protectedRanges),
  };
  if (base.blocks.length > LIMITS.blocks) {
    return fallback("document-limit");
  }
  const preserved: DictationFormattingResult = {
    status: "preserved",
    originalText: text,
    ...renderDictationDocument(base),
    document: base,
    counts: { blocks: base.blocks.length, items: 0, depth: 0 },
    candidates: [],
  };
  if (mode === "preserve") {
    return preserved;
  }
  if (options.locale && !/^en(?:-|$)/i.test(options.locale)) {
    return { ...preserved, status: "needs-review", reason: "unsupported-command-locale" };
  }
  const candidates = dictationMarkerCandidates(text, base.protectedRanges);
  if (!candidates) {
    return { ...preserved, status: "needs-review", reason: "too-many-ambiguous-commands" };
  }
  const confirmation = options.confirmedMarkers ?? [];
  if (
    !Array.isArray(confirmation) ||
    confirmation.length > LIMITS.confirmationCandidates ||
    confirmation.some(
      (range, index) =>
        !range ||
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        !candidates.some(
          (candidate) =>
            candidate.source.start === range.start && candidate.source.end === range.end,
        ) ||
        confirmation.slice(0, index).some((previous) => previous.start === range.start),
    )
  ) {
    return fallback("invalid-marker-confirmation");
  }
  const confirmedMarkers = confirmation.toSorted((left, right) => left.start - right.start);
  const candidate = explicitDocument(base, confirmedMarkers);
  if (typeof candidate === "string") {
    return { ...preserved, status: "needs-review", reason: candidate, candidates };
  }
  if (!candidate.consumedMarkers.length) {
    return candidates.length
      ? { ...preserved, status: "needs-review", reason: "ambiguous-structure", candidates }
      : preserved;
  }
  const validated = validateDictationDocument(candidate);
  if (!validated.ok) {
    return { ...preserved, status: "raw-fallback", reason: validated.reason };
  }
  return {
    status: "formatted",
    originalText: text,
    ...renderDictationDocument(validated.document),
    document: validated.document,
    counts: validated.counts,
    candidates: candidates.filter(
      (unresolved) =>
        !confirmedMarkers.some(
          (confirmed) =>
            unresolved.source.start === confirmed.start && unresolved.source.end === confirmed.end,
        ),
    ),
  };
}
