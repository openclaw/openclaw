import { findFenceSpanAt, parseFenceSpans } from "../markdown/fences.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

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
};

const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;
const INLINE_DIRECTIVE_TAG_WITH_PADDING_RE =
  /\s*(?:\[\[\s*audio_as_voice\s*\]\]|\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\])\s*/gi;

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

function normalizeDirectiveWhitespace(text: string): string {
  // Extract → normalize prose → restore:
  // Stash every code block (fenced ``` / ~~~ and indent-code 4-space/tab)
  // under a sentinel-delimited placeholder so the prose regexes never touch them.
  const blockSentinel = createBlockSentinel(text);
  const blockPlaceholderRe = new RegExp(`${blockSentinel}(\\d+)${blockSentinel}`, "g");
  const blocks: string[] = [];
  const masked = text.replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[^\n]*|(?:(?:^|\n)(?:    |\t)[^\n]*)+/gm,
    (block) => {
      blocks.push(block);
      return `${blockSentinel}${blocks.length - 1}${blockSentinel}`;
    },
  );

  const normalized = masked
    .replace(/\r\n/g, "\n")
    .replace(/([^\s])[ \t]{2,}([^\s])/g, "$1 $2")
    .replace(/^\n+/, "")
    .replace(/^[ \t](?=\S)/, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  return normalized.replace(blockPlaceholderRe, (_, i) => blocks[Number(i)]);
}

type StripInlineDirectiveTagsResult = {
  text: string;
  changed: boolean;
};

type MessageTextPart = {
  type: "text";
  text: string;
} & Record<string, unknown>;

type MessagePart = Record<string, unknown> | null | undefined;

export type DisplayMessageWithContent = {
  content?: unknown;
} & Record<string, unknown>;

export function stripInlineDirectiveTagsForDisplay(text: string): StripInlineDirectiveTagsResult {
  if (!text) {
    return { text, changed: false };
  }
  const withoutAudio = text.replace(AUDIO_TAG_RE, "");
  const stripped = withoutAudio.replace(REPLY_TAG_RE, "");
  return {
    text: stripped,
    changed: stripped !== text,
  };
}

export function stripInlineDirectiveTagsForDelivery(text: string): StripInlineDirectiveTagsResult {
  if (!text) {
    return { text, changed: false };
  }
  const stripped = text.replace(INLINE_DIRECTIVE_TAG_WITH_PADDING_RE, " ");
  const changed = stripped !== text;
  return {
    text: changed ? stripped.trim() : text,
    changed,
  };
}

function isMessageTextPart(part: MessagePart): part is MessageTextPart {
  return Boolean(part) && part?.type === "text" && typeof part.text === "string";
}

/**
 * Strips inline directive tags from message text blocks while preserving message shape.
 * Empty post-strip text stays empty-string to preserve caller semantics.
 */
export function stripInlineDirectiveTagsFromMessageForDisplay(
  message: DisplayMessageWithContent | undefined,
): DisplayMessageWithContent | undefined {
  if (!message) {
    return message;
  }
  if (!Array.isArray(message.content)) {
    return message;
  }
  const cleaned = message.content.map((part) => {
    if (!part || typeof part !== "object") {
      return part;
    }
    const record = part as MessagePart;
    if (!isMessageTextPart(record)) {
      return part;
    }
    return { ...record, text: stripInlineDirectiveTagsForDisplay(record.text).text };
  });
  return { ...message, content: cleaned };
}

/**
 * Split an unclosed trailing `[[…` directive tag from the end of streaming text.
 *
 * Returns `{ text, tail }` where `tail` is the stripped pending fragment (or "").
 * Occurrences of `[[` inside Markdown fenced code blocks are ignored so that
 * code examples like ` ```\n[[some_code]]\n``` ` are never mistakenly truncated.
 */
/**
 * Fence open/close state that can be carried across incremental text chunks.
 * `undefined` means no fence is currently open.
 */
export type FenceState = { markerChar: string; markerLen: number } | undefined;

/**
 * Scan `text` for fence markers and return the updated {@link FenceState}.
 *
 * When called with a prior `state` (from a previous chunk), the scan continues
 * from that state so that fence open/close transitions spanning multiple chunks
 * are tracked correctly.
 */
export function updateFenceState(text: string, state?: FenceState): FenceState {
  let open = state;

  let offset = 0;
  while (offset <= text.length) {
    const nextNewline = text.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    const line = text.slice(offset, lineEnd);

    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (match) {
      const marker = match[2];
      const markerChar = marker?.[0];
      if (marker && markerChar) {
        const markerLen = marker.length;
        if (!open) {
          open = { markerChar, markerLen };
        } else if (open.markerChar === markerChar && markerLen >= open.markerLen) {
          open = undefined;
        }
      }
    }

    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }

  return open;
}

/**
 * Returns `true` if the text ends inside an open (unclosed) fenced code block.
 */
export function endsInsideFence(text: string): boolean {
  return updateFenceState(text) !== undefined;
}

export const splitTrailingDirective = (
  text: string,
  options?: { fenceState?: FenceState },
): { text: string; tail: string } => {
  // When the caller knows we are already inside a fence opened in prior text,
  // prepend a synthetic fence opener so parseFenceSpans sees the correct state.
  let prefix = "";
  if (options?.fenceState) {
    const { markerChar, markerLen } = options.fenceState;
    prefix = `${markerChar.repeat(markerLen)}\n`;
  }
  const adjusted = `${prefix}${text}`;
  const fenceSpans = parseFenceSpans(adjusted);
  const off = prefix.length;
  let searchFrom = text.length;
  while (searchFrom > 0) {
    const openIndex = text.lastIndexOf("[[", searchFrom - 1);
    if (openIndex < 0) {
      return { text, tail: "" };
    }

    // `[[` is inside a fenced code block — skip and continue searching leftward.
    if (findFenceSpanAt(fenceSpans, openIndex + off)) {
      searchFrom = openIndex;
      continue;
    }

    // Found a `[[` outside any fence — scan forward for a `]]` that is also
    // outside a fence.  Skip over any `]]` that falls inside a fenced block.
    let closeSearch = openIndex + 2;
    let closed = false;
    while (closeSearch < text.length) {
      const closeIndex = text.indexOf("]]", closeSearch);
      if (closeIndex < 0) {
        break;
      }
      if (!findFenceSpanAt(fenceSpans, closeIndex + off)) {
        closed = true;
        break;
      }
      closeSearch = closeIndex + 2;
    }

    if (closed) {
      // Paired `]]` exists outside a fence — complete directive tag, no truncation needed.
      return { text, tail: "" };
    }

    // Unclosed `[[` outside a fence — truncate into tail.
    return {
      text: text.slice(0, openIndex),
      tail: text.slice(openIndex),
    };
  }

  return { text, tail: "" };
};

/**
 * Strip an unclosed trailing `[[…` (or lone `[`) directive fragment from text.
 *
 * Convenience wrapper around {@link splitTrailingDirective} that returns only the
 * cleaned text string.
 */
export const stripTrailingDirective = (text: string): string => {
  const { text: cleaned } = splitTrailingDirective(text);
  return cleaned;
};

export function parseInlineDirectives(
  text?: string,
  options: InlineDirectiveParseOptions = {},
): InlineDirectiveParseResult {
  const { currentMessageId, stripAudioTag = true, stripReplyTags = true } = options;
  if (!text) {
    return {
      text: "",
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }
  if (!text.includes("[[")) {
    return {
      text: normalizeDirectiveWhitespace(text),
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }

  let cleaned = text;
  let audioAsVoice = false;
  let hasAudioTag = false;
  let hasReplyTag = false;
  let sawCurrent = false;
  let lastExplicitId: string | undefined;

  cleaned = cleaned.replace(AUDIO_TAG_RE, (match, offset, source) => {
    audioAsVoice = true;
    hasAudioTag = true;
    return stripAudioTag ? replacementPreservesWordBoundary(source, offset, match.length) : match;
  });

  cleaned = cleaned.replace(REPLY_TAG_RE, (match, idRaw: string | undefined, offset, source) => {
    hasReplyTag = true;
    if (idRaw === undefined) {
      sawCurrent = true;
    } else {
      const id = idRaw.trim();
      if (id) {
        lastExplicitId = id;
      }
    }
    return stripReplyTags ? replacementPreservesWordBoundary(source, offset, match.length) : match;
  });

  cleaned = normalizeDirectiveWhitespace(cleaned);

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
