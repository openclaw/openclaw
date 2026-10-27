import { expectDefined } from "@openclaw/normalization-core";
import { scanFenceSpans } from "../../../packages/markdown-core/src/fences.js";
import { escapeRegExp } from "../regexp.js";
import {
  canReuseMarkdownOwnership,
  findCodeOwnership,
  findCodeRegions,
  findTextCheckpoint,
} from "./code-regions.js";
import { stripLeadingEmptyLines } from "./strip-leading-empty-lines.js";
import { trimTextPreservingCode } from "./trim-code-text.js";

export { trimTextPreservingCode };

/** Recombine non-streamed text without destroying Markdown's meaningful indentation. */
export function combineNonStreamingReplyParts(parts: readonly string[]): string {
  let combined = "";
  for (const part of parts) {
    if (!part.trim()) {
      continue;
    }
    // Outbound media normalization trims a chunk's trailing newline, so an
    // indented following chunk still needs its original single-line boundary.
    const separator =
      !combined || /[\r\n]$/.test(combined) || /^[\r\n]/.test(part)
        ? ""
        : /^[\t ]+\S/.test(part)
          ? "\n"
          : "\n\n";
    combined += separator + part;
  }
  return trimTextPreservingCode(combined);
}

export type TextProjection = { text: string; delta: string | null };
type TextProjectionUpdate = TextProjection & {
  // Producer-owned unchanged prefix, ending in non-whitespace, and mutable tail.
  retained?: { prefix: string; tail: string };
};
export type TextProjector = ((input: TextProjectionUpdate) => TextProjectionUpdate) & {
  canReplaceFrom?: (start: number) => boolean;
};
// Token absence must prove identity; activated syntax stays with the canonical transform.
type TextCheckpoint = {
  text: string;
  retainStart: number;
  retainedOutputStart: number;
  retainedContext?: string;
  resetSettled?: boolean;
  commit?: () => void;
};
type CheckpointTransform = (
  text: string,
  settleBefore: number,
  context: { contentStart: number; codeRegions: () => ReturnType<typeof findCodeRegions> },
) => TextCheckpoint;
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
  let checkpointActive = false;
  let previousRetained: TextProjectionUpdate["retained"];
  let identity = true;
  const projector: TextProjector = (input) => {
    if (input.delta === "") {
      if (previousRetained) {
        return { text: identity ? input.text : previous, delta: "", retained: previousRetained };
      }
      return identity ? input : { text: previous, delta: "" };
    }
    const shouldProject = shouldTransform(input);
    const checkpointResult = shouldProject
      ? project?.(input.text, input.delta, previous, input.retained)
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
    checkpointActive ||= Boolean(checkpointResult);
    previous = text;
    identity = nextIdentity;
    const result =
      checkpointResult ?? (nextIdentity && delta === input.delta ? input : { text, delta });
    previousRetained = result.retained;
    return result;
  };
  projector.canReplaceFrom = (start) => checkpointActive && project?.canReplaceFrom(start) === true;
  return projector;
}

function createCheckpointTransform(project: CheckpointTransform) {
  let sourceLength = 0;
  let pending = "";
  let settled = "";
  let settledContent = "";
  let settledWhitespace = "";
  let initialized = false;
  let settledMatchesSource = true;
  let previousTail = "";
  let context = "";
  let references = "";
  const definitions = new Set<string>();
  let previousVisible: string | undefined;
  let previousReset = false;
  let ownershipSource = "";
  let openBlock = false;
  let ownership: ReturnType<typeof findCodeOwnership> | undefined;
  const resolveOwnership = (text: string) => {
    const last = ownership?.regions.at(-1);
    // A new line can advance settlement even when code ranges stay unchanged.
    if (
      ownership &&
      !text.includes("\n", ownershipSource.length) &&
      !text.includes("\r", ownershipSource.length) &&
      (!last?.block || last.end !== ownershipSource.length || openBlock) &&
      canReuseMarkdownOwnership(ownershipSource, text, ownership)
    ) {
      if (openBlock && last) {
        ownership = {
          ...ownership,
          regions: [...ownership.regions.slice(0, -1), { ...last, end: text.length }],
        };
      }
      ownershipSource = text;
      return ownership;
    }
    ownership = findCodeOwnership(text);
    ownershipSource = text;
    const tail = ownership.regions.at(-1);
    const lineStart = tail
      ? Math.max(text.lastIndexOf("\n", tail.start - 1), text.lastIndexOf("\r", tail.start - 1)) + 1
      : 0;
    const topLevel = tail && /^ {0,3}$/u.test(text.slice(lineStart, tail.start));
    openBlock = Boolean(
      tail?.block &&
      tail.end === text.length &&
      ((topLevel && scanFenceSpans(text.slice(tail.start)).state.open) ||
        /^(?: {4}|\t)/u.test(
          text.slice(Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1),
        )),
    );
    return ownership;
  };
  const projector = (
    source: string,
    inputDelta: string | null,
    previousOutput: string,
    retained?: TextProjectionUpdate["retained"],
  ): TextProjectionUpdate => {
    // A validated append delta already names the appended suffix; slicing the cumulative
    // source would flatten the growing reply on every delta once checkpoints are active.
    if (inputDelta === null && retained && initialized) {
      const offset = sourceLength - pending.length;
      pending = pending.slice(0, retained.prefix.length - offset) + retained.tail;
    } else {
      pending +=
        inputDelta !== null && source.length === sourceLength + inputDelta.length
          ? inputDelta
          : source.slice(sourceLength);
    }
    initialized = true;
    sourceLength = source.length;
    const contextLength = references.length + context.length;
    const text = references + context + pending;
    let boundary = findTextCheckpoint(text, references.length, resolveOwnership);
    if (retained) {
      const cap = Math.max(
        contextLength,
        retained.prefix.length - (sourceLength - pending.length) + contextLength,
      );
      if (boundary.offset > cap) {
        boundary = findTextCheckpoint(text.slice(0, cap), references.length, resolveOwnership);
      }
    }
    let regions: ReturnType<typeof findCodeRegions> | undefined;
    const result = project(text, boundary.offset, {
      contentStart: contextLength,
      codeRegions: () =>
        (regions ??= /[`~\t]| {4}/u.test(text) ? resolveOwnership(text).regions : []),
    });
    if (result.retainedContext !== undefined) {
      boundary = { ...boundary, offset: result.retainStart, context: result.retainedContext };
    }
    const window = result.text.slice(contextLength);
    // Reuse unchanged source bytes: comparing separately built cumulative ropes
    // for identity would flatten the whole reply on every append.
    const reset = Boolean(result.resetSettled);
    const visible =
      !reset && settledMatchesSource && result.text === text
        ? source
        : (reset ? "" : settled) + window;
    // Without a reset transition, while the stage kept emitting this transform's output the
    // delta extends the previous visible text exactly when it extends the previous tail.
    // A stream that skipped this transform (activation just flipped, or an upstream
    // passthrough) still compares against the stage's previous output in full.
    const delta =
      inputDelta === null
        ? null
        : reset === previousReset && previousOutput === previousVisible
          ? window.length >= previousTail.length && window.startsWith(previousTail)
            ? window.slice(previousTail.length)
            : null
          : reset === previousReset && visible === source
            ? inputDelta
            : visible.startsWith(previousOutput)
              ? visible.slice(previousOutput.length)
              : null;
    const resetTransition = reset || previousReset;
    let outputRetained = resetTransition
      ? { prefix: "", tail: visible }
      : { prefix: settledContent, tail: settledWhitespace + window };
    previousVisible = visible;
    previousReset = reset;
    // A provisional tool call can retain text before the Markdown checkpoint.
    let retain = 0;
    if (boundary.offset > contextLength && result.retainStart === boundary.offset) {
      if (result.resetSettled) {
        settled = "";
        settledContent = "";
        settledWhitespace = "";
        settledMatchesSource = false;
      }
      result.commit?.();
      const added = result.text.slice(contextLength, result.retainedOutputStart);
      settledMatchesSource &&= added === pending.slice(0, boundary.offset - contextLength);
      const content = added.trimEnd();
      if (content) {
        settledContent = settled + content;
        settledWhitespace = added.slice(content.length);
      } else {
        settledWhitespace += added;
      }
      settled += added;
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
    if (delta !== null && !resetTransition) {
      outputRetained = { prefix: settledContent, tail: settledWhitespace + window.slice(retain) };
    }
    previousTail = window.slice(retain);
    return { text: visible, delta, retained: outputRetained };
  };
  return Object.assign(projector, {
    canReplaceFrom: (start: number) => initialized && start >= sourceLength - pending.length,
  });
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

/** Runs internal stages while preserving their correction provenance. */
export function createTextProjector(filters: readonly TextFilter[]) {
  const stages = filters.map(
    (filter): { filter: TextFilter; projector?: TextProjector; identity?: boolean } => ({
      filter,
    }),
  );
  const project = Object.assign(
    (value: TextProjectionUpdate) => {
      project.boundaryWhitespaceOnly = true;
      let input = value;
      for (const stage of stages) {
        // Replacements can expose earlier syntax, so every downstream probe starts fresh.
        if (
          !stage.projector ||
          (input.delta === null &&
            (!input.retained || !stage.projector.canReplaceFrom?.(input.retained.prefix.length)))
        ) {
          stage.projector =
            "create" in stage.filter
              ? stage.filter.create()
              : createActivatedProjector(stage.filter);
        }
        let next = stage.projector(input);
        if (!stage.filter.boundaryWhitespaceOnly) {
          const identity = next === input || next.text === input.text;
          if (!identity) {
            project.boundaryWhitespaceOnly = false;
          } else if (input.retained && (!next.retained || next.retained === input.retained)) {
            const retained =
              stage.identity === false ? { prefix: "", tail: next.text } : input.retained;
            // An identity stage cannot turn an append watermark into a correction:
            // its advanced prefix can contain bytes absent from the previous tail.
            const delta =
              stage.identity === true && input.delta !== null ? input.delta : next.delta;
            if (next.retained !== retained || next.delta !== delta) {
              next = { ...next, delta, retained };
            }
          }
          stage.identity = identity;
        }
        input = next;
      }
      return input;
    },
    { boundaryWhitespaceOnly: true, canReplaceFrom: () => true },
  );
  return project;
}

export function createTextProjection(filters: readonly TextFilter[]) {
  const project = createTextProjector(filters);
  let source = "";
  let text = "";
  let trimStart = 0;
  let trimEnd = 0;
  let matchesTrimmedSource: boolean | undefined;
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
        (project.boundaryWhitespaceOnly || source.startsWith(text, trimStart)));
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
      matchesTrimmedSource = undefined;
      const next = project({ text: source, delta });
      // A downstream filter can cancel an intermediate replacement without changing the final prefix.
      if (next.delta === null && next.text.startsWith(text)) {
        next.delta = next.text.slice(text.length);
      }
      text = next.text;
      return next.retained ? { text: next.text, delta: next.delta } : next;
    },
    replace(value: string): TextProjection {
      source = value;
      trimStart = value.length - value.trimStart().length;
      trimEnd = value.trimEnd().length;
      matchesTrimmedSource = undefined;
      const next = project({ text: source, delta: null });
      next.delta = null;
      text = next.text;
      return next.retained ? { text: next.text, delta: next.delta } : next;
    },
  };
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
      let removedLeadingLength = 0;
      let retainedInput: TextProjectionUpdate["retained"];
      let retainedPrefix = "";
      let pending = "";
      const mapRetained = (input: TextProjectionUpdate) => {
        const retained = input.retained;
        if (!retained || leading || retained.prefix.length <= removedLeadingLength) {
          retainedInput = undefined;
          return undefined;
        }
        if (retainedInput && retained.prefix.length >= retainedInput.prefix.length) {
          const growth = retained.prefix.length - retainedInput.prefix.length;
          retainedPrefix += (retainedInput.tail + (input.delta ?? "")).slice(0, growth);
        } else {
          retainedPrefix = retained.prefix.slice(removedLeadingLength);
        }
        retainedInput = retained;
        return {
          prefix: retainedPrefix,
          tail: mode === "both" ? retained.tail.trimEnd() : retained.tail,
        };
      };
      const projector: TextProjector = (input) => {
        if (mode === "none") {
          return input;
        }
        if (
          input.delta === null &&
          input.retained &&
          !leading &&
          input.retained.prefix.length > removedLeadingLength
        ) {
          const retained = mapRetained(input);
          if (retained) {
            pending = mode === "both" ? input.retained.tail.slice(retained.tail.length) : "";
            text = retained.prefix + retained.tail;
            return { text, delta: null, retained };
          }
        }
        const appended = input.delta ?? input.text;
        let delta = leading ? appended.trimStart() : appended;
        if (leading && options?.preserveCodeIndentation && delta) {
          // The first visible content classifies any preceding whitespace-only deltas.
          // Replacements create a fresh projector; later appends retain this decision.
          delta = trimTextPreservingCode(input.text, "start");
          removedLeadingLength = input.text.length - delta.length;
        } else if (leading) {
          removedLeadingLength += appended.length - delta.length;
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
        text = removedLeadingLength === 0 && !pending ? input.text : text + delta;
        const retained = mapRetained(input);
        return {
          text,
          delta: input.delta === null ? null : delta,
          ...(retained ? { retained } : {}),
        };
      };
      projector.canReplaceFrom = (start) =>
        mode === "none" ||
        (!leading &&
          retainedInput !== undefined &&
          start >= retainedInput.prefix.length &&
          start > removedLeadingLength);
      return projector;
    },
  };
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

function collapseDuplicateParagraphs(
  text: string,
  protectedRegions?: ReturnType<typeof findCodeRegions>,
): string {
  const collapsed = collapsePlainDuplicateParagraphs(text);
  if (collapsed === text) {
    return text;
  }
  const regions = protectedRegions ?? findCodeRegions(text);
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
  let sourceTail = "";
  let activationTail = "";
  let separator: string | undefined;
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
    if (!separator) {
      const probe = activationTail + appended;
      const boundary = /\r?\n\r?\n/.exec(probe);
      // Retain a CRLF paragraph boundary split across appends.
      activationTail = probe.slice(-3);
      if (!boundary) {
        text = input.text;
        if (protectCode) {
          sourceTail = (sourceTail + appended).slice(-2048);
        }
        return input;
      }
      separator = boundary[0];
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
            completed += (completed ? separator : "") + paragraph;
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
      // A CR between LF tokens can begin a split CRLF boundary.
      if (part[0] !== "\r") {
        newlines = 0;
      }
      const raw = paragraph ? part[0] : part[0].trimStart();
      const content = raw.trimEnd();
      if (!content) {
        pending += raw;
        continue;
      }
      const piece = pending + content;
      pending = raw.slice(content.length);
      if (!paragraph) {
        const empty = separator.repeat(pendingEmpty);
        if (pendingEmpty) {
          completed += empty;
          pendingEmpty = 0;
          lastNormalized = "";
          equal = false;
        }
        added += completed ? empty + separator : "";
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
        (protectCode &&
          (/\s$/.test(text) || !canReuseMarkdownOwnership(sourceTail, sourceTail + appended)))
          ? null
          : added;
      text =
        delta === null
          ? protectCode
            ? collapseDuplicateParagraphs(input.text)
            : completed + (paragraph && !duplicate ? (completed ? separator : "") + paragraph : "")
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
    if (protectCode) {
      sourceTail = (sourceTail + (input.delta ?? input.text)).slice(-2048);
    }
    return { text, delta };
  };
}

export const duplicateParagraphTextFilter: TextFilter = {
  transform: collapseDuplicateParagraphs,
  create() {
    let fallback: TextProjector | undefined;
    let probe: TextProjector | undefined = createDuplicateParagraphProjector(false);
    let duplicate = false;
    const checkpoint = createConditionalTextProjector(
      collapseDuplicateParagraphs,
      () => true,
      (text, settleBefore, context) => {
        const regions = context.codeRegions();
        duplicate = collapseDuplicateParagraphs(text, regions) !== text;
        // Keep the previous paragraph until the next one can no longer become its
        // duplicate. Canonical code spans own which blank lines are separators.
        let previousStart = context.contentStart;
        let paragraphStart = context.contentStart;
        let retainStart = context.contentStart;
        let regionIndex = 0;
        for (const separator of text.slice(context.contentStart).matchAll(/\n{2,}/g)) {
          const start = context.contentStart + separator.index;
          const end = start + separator[0].length;
          let region = regions[regionIndex];
          while (region && region.end <= start) {
            region = regions[++regionIndex];
          }
          if (region && region.start < end) {
            continue;
          }
          if (previousStart <= settleBefore) {
            retainStart = previousStart;
          }
          previousStart = paragraphStart;
          paragraphStart = end;
        }
        return {
          text,
          retainStart,
          retainedOutputStart: retainStart,
          retainedContext: "",
        };
      },
    );
    const projector: TextProjector = (input) => {
      if (fallback) {
        return fallback(input);
      }
      if (probe) {
        if (probe(input).text === input.text) {
          return input;
        }
        probe = undefined;
      }
      const output = checkpoint(input);
      // The first real duplicate can normalize whitespace in earlier paragraphs;
      // the canonical correction owner must see the complete source in that case.
      if (duplicate) {
        fallback = createDuplicateParagraphProjector();
        return fallback({ text: input.text, delta: null });
      }
      return output;
    };
    projector.canReplaceFrom = (start) => !duplicate && checkpoint.canReplaceFrom?.(start) === true;
    return projector;
  },
};
