import { expectDefined } from "@openclaw/normalization-core";
import { scanFenceSpans } from "../../../packages/markdown-core/src/fences.js";
import {
  advanceProtectionScanState,
  createProtectionScanState,
} from "../../../packages/tool-call-repair/src/protection-fast-path.js";
import { escapeRegExp } from "../regexp.js";
import { canReuseMarkdownOwnership, findCodeOwnership, findCodeRegions } from "./code-regions.js";

export type TextProjection = { text: string; delta: string | null };
type TextProjector = (input: TextProjection) => TextProjection;
// Token absence must prove identity; activated syntax stays with the canonical transform.
type TextCheckpoint = { text: string; retainStart: number; retainedOutputStart: number };
type CheckpointTransform = (text: string, settleBefore: number) => TextCheckpoint;
export type TextFilter = {
  transform: (text: string) => string;
  checkpoint?: CheckpointTransform;
  boundaryWhitespaceOnly?: true;
} & ({ activationTokens: readonly string[] } | { create: () => TextProjector });

/** Preserve append provenance while a probe proves that the canonical transform is identity. */
export function createConditionalTextProjector(
  transform: (text: string) => string,
  shouldTransform: (input: TextProjection) => boolean,
  checkpoint?: CheckpointTransform,
): TextProjector {
  const project = checkpoint ? createCheckpointTransform(checkpoint) : undefined;
  let previous = "";
  let identity = true;
  return (input) => {
    if (input.delta === "") {
      return identity ? input : { text: previous, delta: "" };
    }
    const shouldProject = shouldTransform(input);
    const checkpointResult = shouldProject
      ? project?.(input.text, input.delta, previous)
      : undefined;
    const text = checkpointResult?.text ?? (shouldProject ? transform(input.text) : input.text);
    const nextIdentity = text === input.text;
    const delta =
      input.delta === null
        ? null
        : checkpointResult
          ? checkpointResult.delta
          : identity && nextIdentity
            ? input.delta
            : text.startsWith(previous)
              ? text.slice(previous.length)
              : null;
    previous = text;
    identity = nextIdentity;
    return nextIdentity && delta === input.delta ? input : { text, delta };
  };
}

function findTextCheckpoint(
  text: string,
  referenceLength: number,
  resolveOwnership: (text: string) => ReturnType<typeof findCodeOwnership>,
): {
  offset: number;
  context: string;
  definitions?: ReturnType<typeof findCodeOwnership>["definitions"];
} {
  const state = createProtectionScanState();
  let cursor = referenceLength;
  let lastLineStart = cursor;
  let closedFence = false;
  for (let end = text.indexOf("\n", cursor); end !== -1; end = text.indexOf("\n", cursor)) {
    const line = text.slice(cursor, end + 1);
    const inFence = Boolean(state.fenceChar);
    advanceProtectionScanState(state, line);
    // References, image descriptions, and setext headings can need earlier paragraph context.
    if (
      state.paragraphAmbiguous ||
      state.structuralUnknown ||
      (!inFence && !state.fenceChar && /\[|^ {0,3}=+[ \t]*\r?\n$/.test(line))
    ) {
      const ownership = resolveOwnership(text);
      const retain = ownership.retainStart;
      const start = retain === 0 ? 0 : text.lastIndexOf("\n", retain - 1) + 1;
      const completeEnd = text.lastIndexOf("\n") + 1;
      if (
        !/\r(?!\n)/.test(text) &&
        ownership.regions.some((region) => region.block && region.start === retain)
      ) {
        const fence = scanFenceSpans(text.slice(start, completeEnd)).state.open;
        if (fence) {
          return {
            offset: completeEnd,
            context: fence.marker + "\n",
            definitions: ownership.definitions,
          };
        }
      }
      return { offset: start, context: "", definitions: ownership.definitions };
    }
    lastLineStart = cursor;
    cursor = end + 1;
    closedFence = inFence && !state.fenceChar;
  }
  if (state.fenceChar) {
    // Only the proven top-level fence is carried; its settled body is never parsed again.
    return { offset: cursor, context: state.fenceChar.repeat(state.fenceLength) + "\n" };
  }
  return { offset: closedFence ? cursor : lastLineStart, context: "" };
}

function createCheckpointTransform(
  project: CheckpointTransform,
): (source: string, delta: string | null, previous: string) => TextProjection {
  let sourceLength = 0;
  let pending = "";
  let settled = "";
  let previousTail = "";
  let context = "";
  let references = "";
  const definitions = new Set<string>();
  let previousVisible: string | undefined;
  let ownershipSource = "";
  let ownership: ReturnType<typeof findCodeOwnership> | undefined;
  const resolveOwnership = (text: string) => {
    // Code ranges can stay unchanged while a completed list item advances settlement.
    if (
      ownership &&
      !text.includes("\n", ownershipSource.length) &&
      canReuseMarkdownOwnership(ownershipSource, text, ownership)
    ) {
      ownershipSource = text;
      return ownership;
    }
    ownership = findCodeOwnership(text);
    ownershipSource = text;
    return ownership;
  };
  return (source, inputDelta, previousOutput) => {
    // A validated append delta already names the appended suffix; slicing the cumulative
    // source would flatten the growing reply on every delta once checkpoints are active.
    pending +=
      inputDelta !== null && source.length === sourceLength + inputDelta.length
        ? inputDelta
        : source.slice(sourceLength);
    sourceLength = source.length;
    const contextLength = references.length + context.length;
    const text = references + context + pending;
    const boundary = findTextCheckpoint(text, references.length, resolveOwnership);
    const result = project(text, boundary.offset);
    const window = result.text.slice(contextLength);
    const visible = settled + window;
    // `settled` only grows, so while the stage kept emitting this transform's output the
    // delta extends the previous visible text exactly when it extends the previous tail.
    // A stream that skipped this transform (activation just flipped, or an upstream
    // passthrough) still compares against the stage's previous output in full.
    const delta =
      inputDelta === null
        ? null
        : previousOutput === previousVisible
          ? window.length >= previousTail.length && window.startsWith(previousTail)
            ? window.slice(previousTail.length)
            : null
          : visible === source
            ? inputDelta
            : visible.startsWith(previousOutput)
              ? visible.slice(previousOutput.length)
              : null;
    previousVisible = visible;
    // A provisional tool call can retain text before the Markdown checkpoint.
    let retain = 0;
    if (boundary.offset > contextLength && result.retainStart === boundary.offset) {
      settled += result.text.slice(contextLength, result.retainedOutputStart);
      retain = Math.max(0, result.retainedOutputStart - contextLength);
      for (const definition of boundary.definitions ?? []) {
        if (definition.end <= boundary.offset && !definitions.has(definition.identifier)) {
          definitions.add(definition.identifier);
          // Code ownership needs only the normalized label, never its destination or title.
          references += `[${definition.identifier}]: /\n\n`;
        }
      }
      pending = text.slice(boundary.offset);
      context = boundary.context;
    }
    previousTail = window.slice(retain);
    return { text: visible, delta };
  };
}

function createActivatedProjector(
  filter: Extract<TextFilter, { activationTokens: readonly string[] }>,
): TextProjector {
  const activation = new RegExp(filter.activationTokens.map(escapeRegExp).join("|"), "i");
  const overlap = Math.max(0, ...filter.activationTokens.map((token) => token.length - 1));
  let tail = "";
  let active = false;
  return createConditionalTextProjector(
    filter.transform,
    (input) => {
      if (!active) {
        const appended = tail + (input.delta ?? input.text);
        active = activation.test(appended);
        tail = !active && overlap ? appended.slice(-overlap) : "";
      }
      return active;
    },
    filter.checkpoint,
  );
}

export function applyTextFilters(input: string, filters: readonly TextFilter[]): string {
  let text = input;
  for (const filter of filters) {
    text = filter.transform(text);
  }
  return text;
}

export function createTextProjection(filters: readonly TextFilter[]) {
  const stages = filters.map((filter): { filter: TextFilter; projector?: TextProjector } => ({
    filter,
  }));
  let source = "";
  let text = "";
  let trimStart = 0;
  let trimEnd = 0;
  let onlyBoundaryWhitespaceChanged = true;
  let matchesTrimmedSource: boolean | undefined;
  const project = (value: TextProjection) => {
    onlyBoundaryWhitespaceChanged = true;
    matchesTrimmedSource = undefined;
    let input = value;
    for (const stage of stages) {
      // Replacements can expose earlier syntax, so every downstream probe starts fresh.
      if (!stage.projector || input.delta === null) {
        stage.projector =
          "create" in stage.filter ? stage.filter.create() : createActivatedProjector(stage.filter);
      }
      const next = stage.projector(input);
      if (!stage.filter.boundaryWhitespaceOnly && next !== input && next.text !== input.text) {
        onlyBoundaryWhitespaceChanged = false;
      }
      input = next;
    }
    return input;
  };
  return {
    get source() {
      return source;
    },
    get text() {
      return text;
    },
    get matchesTrimmedSource(): boolean {
      // Padding-only stages preserve the source span. Real transforms still need
      // an exact comparison when their output happens to have the same length.
      return (matchesTrimmedSource ??=
        text.length === Math.max(0, trimEnd - trimStart) &&
        (onlyBoundaryWhitespaceChanged || source.startsWith(text, trimStart)));
    },
    append(delta: string, preparedSource?: string): TextProjection {
      if (trimEnd === 0) {
        trimStart += delta.length - delta.trimStart().length;
      }
      const contentLength = delta.trimEnd().length;
      if (contentLength > 0) {
        trimEnd = source.length + contentLength;
      }
      // A validated cumulative snapshot already owns these bytes; rebuilding its
      // rope would copy the growing reply again when a consumer reads it.
      source = preparedSource ?? source + delta;
      const next = project({ text: source, delta });
      // A downstream filter can cancel an intermediate replacement without changing the final prefix.
      if (next.delta === null && next.text.startsWith(text)) {
        next.delta = next.text.slice(text.length);
      }
      text = next.text;
      return next;
    },
    replace(value: string): TextProjection {
      source = value;
      trimStart = value.length - value.trimStart().length;
      trimEnd = value.trimEnd().length;
      const next = project({ text: source, delta: null });
      next.delta = null;
      text = next.text;
      return next;
    },
  };
}

/** Trim surrounding padding without removing Markdown block indentation. */
export function trimTextPreservingCode(
  text: string,
  mode: "start" | "both" = "both",
  codeRegions?: ReturnType<typeof findCodeRegions>,
): string {
  let trimmed = text.trimStart();
  if (trimmed && trimmed.length !== text.length) {
    const contentStart = text.length - trimmed.length;
    const leadingCode = (codeRegions ?? findCodeRegions(text)).find(
      (region) =>
        (region.block || (codeRegions && region.start === 0)) &&
        region.start <= contentStart &&
        contentStart < region.end,
    );
    if (leadingCode) {
      trimmed = text.slice(leadingCode.start);
    }
  }
  if (mode === "both") {
    const contentEnd = text.trimEnd().length;
    if (codeRegions?.some((region) => region.start <= contentEnd && region.end === text.length)) {
      return trimmed;
    }
    return trimmed.trimEnd();
  }
  return trimmed;
}

export function trimTextFilter(
  mode: "none" | "start" | "both",
  options?: { preserveCodeIndentation?: boolean },
): TextFilter {
  return {
    boundaryWhitespaceOnly: true,
    transform: (text) =>
      mode === "none"
        ? text
        : options?.preserveCodeIndentation
          ? trimTextPreservingCode(text, mode)
          : mode === "both"
            ? text.trim()
            : text.trimStart(),
    create: () => {
      let text = "";
      let leading = true;
      let removedLeading = false;
      let pending = "";
      return (input) => {
        if (mode === "none") {
          return input;
        }
        const appended = input.delta ?? input.text;
        let delta = leading ? appended.trimStart() : appended;
        if (leading && options?.preserveCodeIndentation && delta) {
          // The first visible content classifies any preceding whitespace-only deltas.
          // Replacements create a fresh projector; later appends retain this decision.
          delta = trimTextPreservingCode(input.text, "start");
          removedLeading = delta.length !== input.text.length;
        } else {
          removedLeading ||= delta.length !== appended.length;
        }
        leading &&= !delta;
        if (mode === "both") {
          const content = delta.trimEnd();
          if (content) {
            const trailing = delta.slice(content.length);
            delta = pending + content;
            pending = trailing;
          } else {
            pending += delta;
            delta = "";
          }
        }
        text = !removedLeading && !pending ? input.text : text + delta;
        return { text, delta: input.delta === null ? null : delta };
      };
    },
  };
}

function stripLeadingEmptyLines(text: string): string {
  return text.trim() ? text.replace(/^(?:[ \t]*\r?\n)+/, "") : "";
}

export const leadingEmptyLinesTextFilter: TextFilter = {
  transform: stripLeadingEmptyLines,
  create: () => {
    let started = false;
    let identity = false;
    let text = "";
    return (input) => {
      let delta = input.delta ?? input.text;
      if (!started) {
        started = /\S/.test(delta);
        text = started ? stripLeadingEmptyLines(input.text) : "";
        identity = text === input.text;
        delta = text;
      } else {
        text = identity ? input.text : text + delta;
      }
      return { text, delta: input.delta === null ? null : delta };
    };
  },
};

function collapsePlainDuplicateParagraphs(text: string): string {
  return createDuplicateParagraphProjector(false)({ text, delta: null }).text;
}

function collapseDuplicateParagraphs(text: string): string {
  const collapsed = collapsePlainDuplicateParagraphs(text);
  if (collapsed === text) {
    return text;
  }
  const regions = findCodeRegions(text);
  if (regions.length === 0) {
    return collapsed;
  }
  // The marker is absent from source, so each indexed token is collision-free.
  let marker = "\0";
  while (text.includes(marker)) {
    marker += "\0";
  }
  const inlineTokens = new Map<string, string>();
  let masked = "";
  let cursor = 0;
  const protectedText = regions.map((region, index) => {
    const source = text.slice(region.start, region.end);
    let token = `${marker}${index}${marker}`;
    if (!region.block) {
      token = inlineTokens.get(source) ?? token;
      inlineTokens.set(source, token);
    }
    masked += text.slice(cursor, region.start) + token;
    cursor = region.end;
    return source;
  });
  // Only our indexed tokens contain the marker; a callback preserves literal dollar sequences.
  return collapsePlainDuplicateParagraphs(masked + text.slice(cursor)).replace(
    new RegExp(`${marker}(\\d+)${marker}`, "g"),
    (_token, index: string) => expectDefined(protectedText[Number(index)], "protected code text"),
  );
}

function createDuplicateParagraphProjector(protectCode = true): TextProjector {
  let active = false;
  let trailingNewline = false;
  let text = "";
  let completed = "";
  let lastNormalized: string | null = null;
  let pendingEmpty = 0;
  let paragraph = "";
  let pending = "";
  let normalizedLength = 0;
  let equal = false;
  let newlines = 0;
  let hasDuplicate = false;
  let wasCollapsed = false;
  let wasDuplicate = false;
  return (input) => {
    let appended = input.delta ?? input.text;
    if (!active) {
      active = (trailingNewline && appended.startsWith("\n")) || appended.includes("\n\n");
      trailingNewline = appended ? appended.endsWith("\n") : trailingNewline;
      if (!active) {
        text = input.text;
        return input;
      }
      appended = input.text;
    }
    let completedParagraph = false;
    let added = "";
    for (const part of appended.matchAll(/\n+|[^\n]+/g)) {
      if (part[0].startsWith("\n")) {
        if (newlines < 2 && newlines + part[0].length >= 2) {
          // One append can leave and re-enter duplicate state across this boundary.
          completedParagraph = true;
          if (!paragraph) {
            if (lastNormalized !== null) {
              pendingEmpty++;
            }
          } else if (equal && normalizedLength === lastNormalized?.length) {
            hasDuplicate = true;
          } else {
            completed += (completed ? "\n\n" : "") + paragraph;
            lastNormalized = paragraph.replace(/\s+/g, " ");
          }
          paragraph = "";
          pending = "";
          normalizedLength = 0;
          equal = Boolean(lastNormalized);
        } else if (newlines + part[0].length < 2 && paragraph) {
          pending += part[0];
        }
        newlines += part[0].length;
        continue;
      }
      newlines = 0;
      const raw = paragraph ? part[0] : part[0].trimStart();
      const content = raw.trimEnd();
      if (!content) {
        pending += raw;
        continue;
      }
      const piece = pending + content;
      pending = raw.slice(content.length);
      if (!paragraph) {
        const empty = "\n\n".repeat(pendingEmpty);
        if (pendingEmpty) {
          completed += empty;
          pendingEmpty = 0;
          lastNormalized = "";
          equal = false;
        }
        added += completed ? empty + "\n\n" : "";
      }
      paragraph += piece;
      added += piece;
      if (equal) {
        const normalized = piece.replace(/\s+/g, " ");
        equal = lastNormalized?.startsWith(normalized, normalizedLength) === true;
        normalizedLength += normalized.length;
      }
    }
    const duplicate = Boolean(paragraph) && equal && normalizedLength === lastNormalized?.length;
    const collapsed = hasDuplicate || duplicate;
    let delta = input.delta;
    if (collapsed) {
      // Code can expose pending whitespace; the plain suffix cannot safely append across it.
      delta =
        input.delta === null ||
        !wasCollapsed ||
        duplicate !== wasDuplicate ||
        completedParagraph ||
        (protectCode && /\s$/.test(text))
          ? null
          : added;
      text =
        delta === null
          ? protectCode
            ? collapseDuplicateParagraphs(input.text)
            : completed + (paragraph && !duplicate ? (completed ? "\n\n" : "") + paragraph : "")
          : text + delta;
    } else {
      text = input.text;
      // A provisional duplicate can diverge, restoring every original separator, not just its own.
      if (wasCollapsed) {
        delta = null;
      }
    }
    wasCollapsed = collapsed;
    wasDuplicate = duplicate;
    return { text, delta };
  };
}

export const duplicateParagraphTextFilter: TextFilter = {
  transform: collapseDuplicateParagraphs,
  create: createDuplicateParagraphProjector,
};
