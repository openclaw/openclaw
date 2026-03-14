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

/**
 * Collapse runs of spaces/tabs to a single space and strip whitespace around
 * newlines, but **preserve fenced code blocks verbatim** so that indented
 * YAML, code examples, and other whitespace-sensitive content is not mangled
 * after directive tags are stripped.
 *
 * Fenced code blocks (``` ``` ``` or ~~~) are detected by the CommonMark rules:
 * an opening fence of 3+ identical chars at the start of a line, with a
 * matching closing fence of the same character type.
 */
function normalizeDirectiveWhitespace(text: string): string {
  // Regex to match fenced code blocks in their entirety.
  // Two alternatives for backtick and tilde fences respectively.
  // The non-greedy [\s\S]*? ensures we match the nearest closing fence.
  const FENCED_CODE_RE =
    /^(`{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$|^(~{3,})[^\n]*\n[\s\S]*?\n\2[ \t]*$/gm;

  const normalizeSection = (s: string): string =>
    s.replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n");

  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  FENCED_CODE_RE.lastIndex = 0;
  while ((match = FENCED_CODE_RE.exec(text)) !== null) {
    // Normalize the plain-text section before this code block.
    parts.push(normalizeSection(text.slice(last, match.index)));
    // Preserve the fenced code block exactly as written.
    parts.push(match[0]);
    last = match.index + match[0].length;
  }
  // Normalize any remaining text after the last code block.
  parts.push(normalizeSection(text.slice(last)));

  return parts.join("").trim();
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

  cleaned = cleaned.replace(AUDIO_TAG_RE, (match) => {
    audioAsVoice = true;
    hasAudioTag = true;
    return stripAudioTag ? " " : match;
  });

  cleaned = cleaned.replace(REPLY_TAG_RE, (match, idRaw: string | undefined) => {
    hasReplyTag = true;
    if (idRaw === undefined) {
      sawCurrent = true;
    } else {
      const id = idRaw.trim();
      if (id) {
        lastExplicitId = id;
      }
    }
    return stripReplyTags ? " " : match;
  });

  cleaned = normalizeDirectiveWhitespace(cleaned);

  const replyToId =
    lastExplicitId ?? (sawCurrent ? currentMessageId?.trim() || undefined : undefined);

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
