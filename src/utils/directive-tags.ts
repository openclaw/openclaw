import { expectDefined } from "@openclaw/normalization-core";
import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";
import { trimTextPreservingCode } from "../shared/text/text-projection.js";

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
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;
const INLINE_DIRECTIVE_TAG_WITH_PADDING_RE =
  /(?:\s*(?:\[\[\s*audio_as_voice\s*\]\]|\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\])\s*|^[\t ]*\[\[\s*(?:reply_to_current(?:[\t ]*\](?!\])|(?=[\t ]+\S)|[\t ]*$)|reply_to\s*:\s*(?:[^\]\r\n]*\](?!\])|[\t ]*$))[\t ]*)/iuy;
const MAX_REPLY_DIRECTIVE_ID_LENGTH = 256;
const UNSAFE_REPLY_DIRECTIVE_CHARS_RE = /[\p{Cc}[\]]/gu;
const NO_INLINE_DIRECTIVES = {
  audioAsVoice: false,
  replyToCurrent: false,
  hasAudioTag: false,
  hasReplyTag: false,
} as const;

function replacementPreservesWordBoundary(source: string, offset: number, length: number): string {
  const before = source[offset - 1];
  const after = source[offset + length];
  return before && after && !/\s/u.test(before) && !/\s/u.test(after) ? " " : "";
}

const BLOCK_SENTINEL_SEED = "\uE000";

function createBlockSentinel(text: string): string {
  let sentinel = BLOCK_SENTINEL_SEED;
  while (text.includes(sentinel)) {
    sentinel += BLOCK_SENTINEL_SEED;
  }
  return sentinel;
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

type DirectiveWhitespaceTailMode = "trim" | "preserve" | "normalize";

function normalizeDirectiveWhitespace(
  text: string,
  tailMode: DirectiveWhitespaceTailMode = "trim",
): string {
  // Stash canonical code regions before normalizing prose. Indented code also
  // occurs inside Markdown containers without any backtick or tilde delimiter.
  const blockSentinel = createBlockSentinel(text);
  const blockPlaceholderRe = new RegExp(`${blockSentinel}(\\d+)${blockSentinel}`, "g");
  const blocks: string[] = [];
  const codeRegions = findCodeRegions(text);
  let masked = "";
  let cursor = 0;
  // The canonical scanner keeps false closers, indented closers, and open fences intact.
  for (const span of codeRegions) {
    blocks.push(text.slice(span.start, span.end));
    masked += `${text.slice(cursor, span.start)}${blockSentinel}${blocks.length - 1}${blockSentinel}`;
    cursor = span.end;
  }
  masked += text.slice(cursor);

  const suffixStart = tailMode === "preserve" ? masked.trimEnd().length : masked.length;
  const suffix = masked.slice(suffixStart);
  const normalized = masked
    .slice(0, suffixStart)
    .replace(/\r\n/g, "\n")
    .replace(/([^\s])[ \t]{2,}([^\s])/g, "$1 $2")
    .replace(/^\n+/, "")
    .replace(/^[ \t](?=\S)/, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  return (tailMode === "trim" ? normalized.trimEnd() : normalized + suffix).replace(
    blockPlaceholderRe,
    (_, i) => expectDefined(blocks[Number(i)], "blocks entry at number(i)"),
  );
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
  const stripped = replaceOutsideCodeRegions(withoutAudio, REPLY_TAG_RE, () => "");
  return {
    text: stripped,
    changed: stripped !== text,
  };
}

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

export function stripInlineDirectiveTagsForDelivery(
  text: string,
  options?: { preserveTrailingWhitespace?: boolean },
): StripInlineDirectiveTagsResult {
  if (!text.includes("[[")) {
    return { text, changed: false };
  }
  // Only malformed prefixes at the absolute message start are control text; keep
  // the regex non-multiline while code-region scanning preserves literal examples.
  let codeRegions: ReturnType<typeof findCodeRegions> | undefined;
  const parts: string[] = [];
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
    INLINE_DIRECTIVE_TAG_WITH_PADDING_RE.lastIndex = start;
    const match = INLINE_DIRECTIVE_TAG_WITH_PADDING_RE.exec(text);
    searchFrom = match ? INLINE_DIRECTIVE_TAG_WITH_PADDING_RE.lastIndex : marker + 1;
    if (!match) {
      continue;
    }
    previousMatchEnd = searchFrom;
    if (isInsideCode(marker, (codeRegions ??= findCodeRegions(text)))) {
      continue;
    }
    // Padding before the next code block owns its line break and indentation.
    const preserveCodePadding = codeRegions.some(
      (region) => region.block && region.start > marker && region.start <= searchFrom,
    );
    parts.push(
      text.slice(cursor, start),
      !preserveCodePadding && match[0].includes("]]") ? " " : "",
    );
    cursor = preserveCodePadding ? start + match[0].trimEnd().length : searchFrom;
  }
  if (cursor === 0) {
    return { text, changed: false };
  }
  const stripped = [...parts, text.slice(cursor)].join("");
  return {
    text: trimTextPreservingCode(stripped, options?.preserveTrailingWhitespace ? "start" : "both"),
    changed: true,
  };
}

export function parseInlineDirectives(
  text?: string,
  options: InlineDirectiveParseOptions = {},
): InlineDirectiveParseResult {
  const {
    currentMessageId,
    stripAudioTag = true,
    stripReplyTags = true,
    preserveTrailingWhitespace = false,
    onAudioDirective,
  } = options;
  if (!text) {
    return { text: "", ...NO_INLINE_DIRECTIVES };
  }
  if (!text.includes("[[")) {
    return {
      text: normalizeDirectiveWhitespace(text, preserveTrailingWhitespace ? "preserve" : "trim"),
      ...NO_INLINE_DIRECTIVES,
    };
  }

  let cleaned = text;
  let audioAsVoice = false;
  let hasAudioTag = false;
  let hasReplyTag = false;
  let sawCurrent = false;
  let lastExplicitId: string | undefined;
  let removedTrailingDirectiveLine = false;
  let trailingContentEnd = preserveTrailingWhitespace ? cleaned.trimEnd().length : 0;
  const stripDirective = (match: string, offset: number, source: string) => {
    if (
      preserveTrailingWhitespace &&
      !removedTrailingDirectiveLine &&
      offset + match.length === trailingContentEnd
    ) {
      const lineStart =
        Math.max(source.lastIndexOf("\n", offset - 1), source.lastIndexOf("\r", offset - 1)) + 1;
      removedTrailingDirectiveLine = /^[\t ]*$/.test(source.slice(lineStart, offset));
    }
    return replacementPreservesWordBoundary(source, offset, match.length);
  };

  cleaned = replaceOutsideCodeRegions(cleaned, AUDIO_TAG_RE, (match, _captures, offset, source) => {
    audioAsVoice = true;
    hasAudioTag = true;
    onAudioDirective?.();
    return stripAudioTag ? stripDirective(match, offset, source) : match;
  });

  trailingContentEnd = preserveTrailingWhitespace ? cleaned.trimEnd().length : 0;
  cleaned = replaceOutsideCodeRegions(cleaned, REPLY_TAG_RE, (match, captures, offset, source) => {
    const idRaw = typeof captures[0] === "string" ? captures[0] : undefined;
    hasReplyTag = true;
    if (idRaw === undefined) {
      sawCurrent = true;
    } else {
      const id = sanitizeReplyDirectiveId(idRaw);
      if (id) {
        lastExplicitId = id;
      }
    }
    return stripReplyTags ? stripDirective(match, offset, source) : match;
  });

  if (!hasAudioTag && !hasReplyTag) {
    return { text, ...NO_INLINE_DIRECTIVES };
  }

  // Removing a trailing directive-only line exposes separators, not an authored text suffix.
  const tailMode = preserveTrailingWhitespace
    ? removedTrailingDirectiveLine
      ? "normalize"
      : "preserve"
    : "trim";
  cleaned = normalizeDirectiveWhitespace(cleaned, tailMode);

  const replyToId =
    lastExplicitId ?? (sawCurrent ? normalizeOptionalString(currentMessageId) : undefined);

  return {
    text: cleaned,
    audioAsVoice,
    replyToId,
    replyToExplicitId: lastExplicitId,
    replyToCurrent: sawCurrent,
    hasAudioTag,
    hasReplyTag,
  };
}
