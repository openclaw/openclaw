import { expectDefined } from "@openclaw/normalization-core";
import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createTextPartCodeRegionResolver,
  indexTextParts,
  findCodeRegions,
  findCodeOwnership,
  isInsideCode,
  type CodeRegion,
} from "../shared/text/code-regions.js";
import {
  createConditionalTextProjector,
  trimTextPreservingCode,
  type TextFilter,
} from "../shared/text/text-projection.js";
import { createInlineReplyTagReader } from "./inline-reply-tags.js";

export type InlineDirectiveParseResult = {
  text: string;
  audioAsVoice: boolean;
  replyToId?: string;
  replyToExplicitId?: string;
  replyToCurrent: boolean;
  hasAudioTag: boolean;
  hasReplyTag: boolean;
};

type InlineDirectiveParseOptions = {
  currentMessageId?: string;
  stripAudioTag?: boolean;
  stripReplyTags?: boolean;
  preserveTrailingWhitespace?: boolean;
  /** Observes each audio directive accepted outside canonical code regions. */
  onAudioDirective?: () => void;
};

// TRANSITIONAL(marker-retirement): inline reply/audio markers are the last text
// adapter for automatic-mode replies. Delete this parser family when the
// messages.visibleReplies default flips to "message_tool" (structured fields own
// delivery intent; persisted transcripts already carry openclawDelivery facts).
const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const DELIVERY_AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/iuy;
const MAX_REPLY_DIRECTIVE_ID_LENGTH = 256;
const UNSAFE_REPLY_DIRECTIVE_CHARS_RE = /[\p{Cc}[\]]/gu;
const NO_INLINE_DIRECTIVES = {
  audioAsVoice: false,
  replyToCurrent: false,
  hasAudioTag: false,
  hasReplyTag: false,
} as const;

// Stripped directives leave this marker so cleanup edits only their own
// neighborhood; authored spacing elsewhere (for example `<pre>` columns) stays.
const REMOVED_DIRECTIVE_MARKER_SEED = "\uE000";

function createRemovedDirectiveMarker(parts: readonly string[]): string {
  let marker = REMOVED_DIRECTIVE_MARKER_SEED;
  while (parts.some((part) => part.includes(marker))) {
    marker += REMOVED_DIRECTIVE_MARKER_SEED;
  }
  return marker;
}

export function replaceOutsideCodeRegions(
  text: string,
  regex: RegExp,
  replacement: (match: string, captures: unknown[], offset: number, source: string) => string,
): string {
  let codeRegions: ReturnType<typeof findCodeRegions> | undefined;
  return text.replace(regex, (...args: unknown[]) => {
    codeRegions ??= text.includes("[[") ? findCodeRegions(text) : [];
    const match = String(args[0]);
    const offset = args.at(-2);
    return typeof offset === "number" && isInsideCode(offset + match.indexOf("[["), codeRegions)
      ? match
      : replacement(match, args.slice(1, -2), Number(offset), text);
  });
}

type NativeTextEdit = { start: number; end: number; text: string };

type TextReplacement = Parameters<typeof replaceOutsideCodeRegions>[2];
type TextReplacer = (text: string, replacement: TextReplacement) => string;

function replaceReplyTagsOutsideCodeRegions(text: string, replacement: TextReplacement): string {
  const readReply = createInlineReplyTagReader(text);
  let codeRegions: ReturnType<typeof findCodeRegions> | undefined;
  let cursor = 0;
  let searchFrom = 0;
  let result = "";
  while (searchFrom < text.length) {
    const marker = text.indexOf("[[", searchFrom);
    if (marker < 0) {
      break;
    }
    const tag = readReply(marker);
    searchFrom = tag ? tag.end : marker + 1;
    if (!tag || isInsideCode(marker, (codeRegions ??= findCodeRegions(text)))) {
      continue;
    }
    result += text.slice(cursor, marker);
    result += replacement(text.slice(marker, tag.end), [tag.id], marker, text);
    cursor = tag.end;
  }
  return result + text.slice(cursor);
}

function applyNativeTextEdits(parts: readonly string[], edits: NativeTextEdit[]): string[] {
  const source = indexTextParts(parts);
  const result = [...parts];
  let editIndex = 0;
  for (const span of source.spans) {
    let cursor = span.start;
    let text = "";
    while (editIndex < edits.length) {
      const edit = expectDefined(edits[editIndex], "native text edit");
      if (edit.end <= span.start) {
        editIndex++;
        continue;
      }
      if (edit.start > span.end) {
        break;
      }
      text += source.text.slice(cursor, Math.max(cursor, Math.min(edit.start, span.end)));
      if (edit.start >= span.start) {
        text += edit.text;
      }
      cursor = Math.min(span.end, Math.max(cursor, edit.end));
      if (edit.end <= span.end) {
        editIndex++;
      } else {
        break;
      }
    }
    result[span.index] = text + source.text.slice(cursor, span.end);
  }
  // A directive can consume the virtual separator between parts. Keep every
  // native slot/signature, but join its surviving fragments in the starting slot.
  let owner = source.spans[0]?.index;
  editIndex = 0;
  for (let index = 1; index < source.spans.length; index++) {
    const before = expectDefined(source.spans[index - 1], "preceding native part");
    const next = expectDefined(source.spans[index], "following native part");
    while (
      edits[editIndex] &&
      expectDefined(edits[editIndex], "boundary text edit").end <= before.end
    ) {
      editIndex++;
    }
    const edit = edits[editIndex];
    if (owner !== undefined && edit && edit.start <= before.end && edit.end > before.end) {
      result[owner] =
        expectDefined(result[owner], "native edit owner") +
        expectDefined(result[next.index], "native edit continuation");
      result[next.index] = "";
    } else {
      owner = next.index;
    }
  }
  return result;
}

/** Replace one syntax stage with full-message code ownership and native edit positions. */
export function replaceOutsideCodeRegionParts(
  parts: readonly string[],
  regex: RegExp,
  replacement: (
    match: string,
    captures: unknown[],
    offset: number,
    source: string,
    partIndex: number,
  ) => string,
): string[] {
  return replaceTextParts(
    parts,
    (text, replace) => replaceOutsideCodeRegions(text, regex, replace),
    replacement,
  );
}

function replaceTextParts(
  parts: readonly string[],
  replace: TextReplacer,
  replacement: Parameters<typeof replaceOutsideCodeRegionParts>[2],
): string[] {
  const source = indexTextParts(parts);
  const edits: NativeTextEdit[] = [];
  let part = 0;
  replace(source.text, (match, captures, offset, text) => {
    while (
      source.spans[part + 1] &&
      expectDefined(source.spans[part + 1], "next text part").start <= offset
    ) {
      part++;
    }
    const value = replacement(
      match,
      captures,
      offset,
      text,
      expectDefined(source.spans[part], "directive start part").index,
    );
    if (value !== match) {
      edits.push({ start: offset, end: offset + match.length, text: value });
    }
    return value;
  });
  return edits.length ? applyNativeTextEdits(parts, edits) : [...parts];
}

type DirectiveWhitespaceTailMode = "trim" | "preserve";

function isLineBreak(char: string | undefined): boolean {
  return char === "\n" || char === "\r";
}

function isBlank(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

/**
 * Joins the text around each removed directive without touching other whitespace.
 * Output is built from pieces with incremental tail facts so many directives stay linear.
 */
function closeRemovedDirectiveGaps(text: string, marker: string): string {
  if (!text.includes(marker)) {
    return text;
  }
  const contentEnd = text.trimEnd().length;
  const out: string[] = [];
  // Last non-blank output character; undefined while the output is empty or blank.
  let lastContentChar: string | undefined;
  const push = (piece: string) => {
    out.push(piece);
    for (let i = piece.length - 1; i >= 0; i -= 1) {
      if (!isBlank(piece[i])) {
        lastContentChar = piece[i];
        return;
      }
    }
  };
  // Each trimmed character leaves the output once, so repeated trims stay linear.
  const trimTrailingBlanks = () => {
    while (out.length > 0) {
      const last = out[out.length - 1] ?? "";
      let end = last.length;
      while (end > 0 && isBlank(last[end - 1])) {
        end -= 1;
      }
      if (end > 0) {
        out[out.length - 1] = last.slice(0, end);
        return;
      }
      out.pop();
    }
  };
  // Consecutive line breaks ending the output, counted up to the two a seam may keep.
  const trailingBreaks = () => {
    let breaks = 0;
    for (let p = out.length - 1; p >= 0; p -= 1) {
      const piece = out[p] ?? "";
      for (let i = piece.length - 1; i >= 0; i -= 1) {
        if (piece[i] === "\n") {
          breaks += 1;
          if (breaks >= 2) {
            return breaks;
          }
        } else if (piece[i] !== "\r") {
          return breaks;
        }
      }
    }
    return breaks;
  };
  let cursor = 0;
  for (;;) {
    const markerStart = text.indexOf(marker, cursor);
    if (markerStart < 0) {
      push(text.slice(cursor));
      return out.join("");
    }
    let markerEnd = markerStart + marker.length;
    while (text.startsWith(marker, markerEnd)) {
      markerEnd += marker.length;
    }
    push(text.slice(cursor, markerStart));
    let next = markerEnd;
    while (isBlank(text[next])) {
      next += 1;
    }
    const atLineStart = lastContentChar === undefined || isLineBreak(lastContentChar);
    const atLineEnd = next >= text.length || isLineBreak(text[next]);
    if (atLineStart && atLineEnd) {
      // A directive-only line leaves at most one blank line at its seam.
      trimTrailingBlanks();
      let breaks = trailingBreaks();
      while (isLineBreak(text[next])) {
        const width = text.startsWith("\r\n", next) ? 2 : 1;
        if (breaks < 2) {
          push(text.slice(next, next + width));
          breaks += 1;
        }
        next += width;
      }
    } else if (atLineStart || next >= contentEnd) {
      // Following indentation belongs to the next content, and trailing message
      // whitespace belongs to the caller's tail mode, not to the directive.
      next = markerEnd;
    } else {
      trimTrailingBlanks();
      if (!atLineEnd) {
        push(" ");
      }
    }
    cursor = next;
  }
}

function trimDirectiveMessageBoundaries(
  text: string,
  tailMode: DirectiveWhitespaceTailMode,
  preparedRegions?: readonly CodeRegion[],
): string {
  let regions = preparedRegions;
  // Code regions own their padding, including a leading tab that starts an indented block.
  const inCode = (offset: number) =>
    (regions ??= findCodeRegions(text)).some(
      (region) => region.start <= offset && offset < region.end,
    );
  let start = /^(?:\r?\n)*/u.exec(text)?.[0].length ?? 0;
  if (/^[ \t]\S/u.test(text.slice(start, start + 2)) && !inCode(start)) {
    start += 1;
  }
  let end = text.length;
  if (tailMode === "trim") {
    const contentEnd = text.trimEnd().length;
    // An open code block at the end owns its trailing bytes.
    const codeOwnsTail =
      contentEnd < end &&
      (regions ??= findCodeRegions(text)).some(
        (region) => region.start <= contentEnd && region.end === text.length,
      );
    end = codeOwnsTail ? end : Math.max(contentEnd, start);
  }
  return text.slice(start, end);
}

type StripInlineDirectiveTagsResult = {
  text: string;
  changed: boolean;
};

export function stripInlineDirectiveTagsForDisplay(text: string): StripInlineDirectiveTagsResult {
  if (!text) {
    return { text, changed: false };
  }
  const withoutAudio = replaceOutsideCodeRegions(text, AUDIO_TAG_RE, () => "");
  const stripped = replaceReplyTagsOutsideCodeRegions(withoutAudio, () => "");
  return {
    text: stripped,
    changed: stripped !== text,
  };
}

/** Raw offsets for literal directives whose Markdown code ownership is settled. */
export type StreamDirectiveCodePrefix = {
  end: number;
  checkedRawLength: number;
};

function hasDirectiveCodePrefixOpportunity(source: string, delta: string): boolean {
  if (!delta) {
    return false;
  }
  const deltaStart = source.length - delta.length;
  const start = Math.max(0, deltaStart - 4);
  let separator = -1;
  // A following line can close block code without a blank separator; ownership proves stability.
  for (const match of source.slice(start).matchAll(/(?:\r\n|\n|\r)[^\S\r\n]*\S/g)) {
    if (start + match.index + match[0].length > deltaStart) {
      separator = start + match.index;
    }
  }
  if (separator === -1) {
    return false;
  }
  const lastMarker = source.lastIndexOf("[[");
  return lastMarker !== -1 && separator > lastMarker;
}

export function findDirectiveCodePrefix(
  source: string,
  delta: string,
): StreamDirectiveCodePrefix | undefined {
  if (!hasDirectiveCodePrefixOpportunity(source, delta)) {
    return undefined;
  }
  const { regions, retainStart, completedParagraphs } = findCodeOwnership(source);
  let regionIndex = 0;
  let paragraphIndex = 0;
  let end = 0;
  for (
    let marker = source.indexOf("[[");
    marker !== -1;
    marker = source.indexOf("[[", marker + 1)
  ) {
    let region = regions[regionIndex];
    while (region && region.end <= marker) {
      region = regions[++regionIndex];
    }
    let paragraph = completedParagraphs[paragraphIndex];
    while (paragraph && paragraph.end <= marker) {
      paragraph = completedParagraphs[++paragraphIndex];
    }
    if (!region || region.start > marker || region.end < marker + 2) {
      return undefined;
    }
    if (region.block) {
      if (region.end > retainStart) {
        return undefined;
      }
      end = region.end;
      continue;
    }
    if (
      !paragraph ||
      paragraph.hasReferenceCandidate ||
      paragraph.start > region.start ||
      paragraph.end < region.end
    ) {
      return undefined;
    }
    end = paragraph.end;
  }
  return end ? { end, checkedRawLength: source.length } : undefined;
}

/** Retain only literal directives whose Markdown ownership cannot change on append. */
export const inlineDirectiveDisplayTextFilter: TextFilter = {
  transform: (text) => stripInlineDirectiveTagsForDisplay(text).text,
  create: () => {
    let prefix: StreamDirectiveCodePrefix | undefined;
    let hasMarker = false;
    let previousChar = "";
    let delta = "";
    return createConditionalTextProjector(
      (text) => {
        const projected = stripInlineDirectiveTagsForDisplay(text).text;
        prefix = projected === text ? findDirectiveCodePrefix(text, delta) : undefined;
        return projected;
      },
      (input) => {
        delta = input.delta ?? input.text;
        if ((previousChar + delta).includes("[[")) {
          hasMarker = true;
          prefix = undefined;
        }
        if (delta) {
          previousChar = delta.slice(-1);
        }
        if (prefix) {
          prefix.checkedRawLength = input.text.length;
        }
        return hasMarker && !prefix;
      },
    );
  },
};

export function sanitizeReplyDirectiveId(rawReplyToId?: string): string | undefined {
  const trimmed = rawReplyToId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = trimmed.replace(UNSAFE_REPLY_DIRECTIVE_CHARS_RE, "").trim();
  if (!sanitized) {
    return undefined;
  }
  // UTF-16 length is an upper bound on the number of code points.
  return sanitized.length <= MAX_REPLY_DIRECTIVE_ID_LENGTH
    ? sanitized
    : truncateCodePoints(sanitized, MAX_REPLY_DIRECTIVE_ID_LENGTH);
}

function collectDeliveryDirectiveEdits(text: string): NativeTextEdit[] {
  if (!text.includes("[[")) {
    return [];
  }
  // Only malformed prefixes at the absolute message start are control text.
  const readReply = createInlineReplyTagReader(text);
  let codeRegions: ReturnType<typeof findCodeRegions> | undefined;
  const edits: NativeTextEdit[] = [];
  let cursor = 0;
  let searchFrom = 0;
  // A preserved code match still owns its padding; later directives must not consume it.
  let previousMatchEnd = 0;
  while (searchFrom < text.length) {
    const marker = text.indexOf("[[", searchFrom);
    if (marker < 0) {
      break;
    }
    // Inspect padding only at a marker; retrying from every blank line is quadratic.
    let start = marker;
    while (start > previousMatchEnd && /\s/u.test(text.charAt(start - 1))) {
      start -= 1;
    }
    DELIVERY_AUDIO_TAG_RE.lastIndex = marker;
    const audio = DELIVERY_AUDIO_TAG_RE.exec(text);
    const reply = audio ? null : readReply(marker, true);
    if (!audio && !reply) {
      searchFrom = marker + 1;
      continue;
    }
    const complete = Boolean(audio) || reply?.complete;
    searchFrom = audio ? DELIVERY_AUDIO_TAG_RE.lastIndex : expectDefined(reply, "reply tag").end;
    if (complete) {
      while (searchFrom < text.length && /\s/u.test(text.charAt(searchFrom))) {
        searchFrom += 1;
      }
    }
    previousMatchEnd = searchFrom;
    if (isInsideCode(marker, (codeRegions ??= findCodeRegions(text)))) {
      continue;
    }
    // Padding before the next code block owns its line break and indentation.
    const preserveCodePadding = codeRegions.some(
      (region) => region.block && region.start > marker && region.start <= searchFrom,
    );
    cursor = preserveCodePadding
      ? start + text.slice(start, searchFrom).trimEnd().length
      : searchFrom;
    edits.push({
      start,
      end: cursor,
      text: !preserveCodePadding && complete ? " " : "",
    });
  }
  if (cursor === 0) {
    return [];
  }
  return edits;
}

export function stripInlineDirectivePartsForDelivery(
  parts: readonly string[],
  options?: { preserveTrailingWhitespace?: boolean },
): StripInlineDirectiveTagsResult[] {
  const edits = collectDeliveryDirectiveEdits(indexTextParts(parts).text);
  if (!edits.length) {
    return parts.map((text) => ({ text, changed: false }));
  }
  const stripped = applyNativeTextEdits(parts, edits);
  const regions = stripped.length > 1 ? createTextPartCodeRegionResolver(stripped) : undefined;
  return stripped.map((text, index) => ({
    text:
      text === parts[index]
        ? text
        : trimTextPreservingCode(
            text,
            options?.preserveTrailingWhitespace ? "start" : "both",
            regions?.(index),
          ),
    changed: text !== parts[index],
  }));
}

export function stripInlineDirectiveTagsForDelivery(
  text: string,
  options?: { preserveTrailingWhitespace?: boolean },
): StripInlineDirectiveTagsResult {
  return expectDefined(
    stripInlineDirectivePartsForDelivery([text], options)[0],
    "single delivery directive part",
  );
}

export function parseInlineDirectives(
  text?: string,
  options: InlineDirectiveParseOptions = {},
): InlineDirectiveParseResult {
  if (!text) {
    return { text: "", ...NO_INLINE_DIRECTIVES };
  }
  if (!text.includes("[[")) {
    return {
      text: trimDirectiveMessageBoundaries(
        text,
        options.preserveTrailingWhitespace ? "preserve" : "trim",
      ),
      ...NO_INLINE_DIRECTIVES,
    };
  }
  return expectDefined(
    parseInlineDirectiveParts([text], options)[0],
    "single inline directive part",
  );
}

export function parseInlineDirectiveParts(
  parts: readonly string[],
  options: InlineDirectiveParseOptions = {},
): InlineDirectiveParseResult[] {
  const {
    currentMessageId,
    stripAudioTag = true,
    stripReplyTags = true,
    preserveTrailingWhitespace = false,
    onAudioDirective,
  } = options;
  const states: Array<{
    audioAsVoice: boolean;
    hasAudioTag: boolean;
    hasReplyTag: boolean;
    sawCurrent: boolean;
    lastExplicitId?: string;
  }> = parts.map(() => ({
    audioAsVoice: false,
    hasAudioTag: false,
    hasReplyTag: false,
    sawCurrent: false,
  }));
  const marker = createRemovedDirectiveMarker(parts);
  const audioText = replaceOutsideCodeRegionParts(
    parts,
    AUDIO_TAG_RE,
    (match, _captures, _offset, _source, partIndex) => {
      const state = expectDefined(states[partIndex], "audio directive part");
      state.audioAsVoice = state.hasAudioTag = true;
      onAudioDirective?.();
      return stripAudioTag ? marker : match;
    },
  ).map((text) => closeRemovedDirectiveGaps(text, marker));
  const replyText = replaceTextParts(
    audioText,
    replaceReplyTagsOutsideCodeRegions,
    (match, captures, _offset, _source, partIndex) => {
      const state = expectDefined(states[partIndex], "reply directive part");
      const idRaw = typeof captures[0] === "string" ? captures[0] : undefined;
      state.hasReplyTag = true;
      if (idRaw === undefined) {
        state.sawCurrent = true;
      } else {
        const id = sanitizeReplyDirectiveId(idRaw);
        if (id) {
          state.lastExplicitId = id;
        }
      }
      return stripReplyTags ? marker : match;
    },
  );
  const closedText = replyText.map((text) => closeRemovedDirectiveGaps(text, marker));
  const regions = parts.length > 1 ? createTextPartCodeRegionResolver(closedText) : undefined;
  return states.map((state, index) => {
    const text = expectDefined(closedText[index], "parsed native text");
    const normalizedText =
      state.hasAudioTag || state.hasReplyTag || text !== parts[index]
        ? trimDirectiveMessageBoundaries(
            text,
            preserveTrailingWhitespace ? "preserve" : "trim",
            regions?.(index),
          )
        : text;
    if (!state.hasAudioTag && !state.hasReplyTag) {
      return Object.assign({ text: normalizedText }, NO_INLINE_DIRECTIVES);
    }
    return {
      text: normalizedText,
      audioAsVoice: state.audioAsVoice,
      replyToId:
        state.lastExplicitId ??
        (state.sawCurrent ? normalizeOptionalString(currentMessageId) : undefined),
      replyToExplicitId: state.lastExplicitId,
      replyToCurrent: state.sawCurrent,
      hasAudioTag: state.hasAudioTag,
      hasReplyTag: state.hasReplyTag,
    };
  });
}
