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

function getDirectiveReplacement(source: string, offset: number, length: number): string {
  const previous = offset > 0 ? source[offset - 1] : "";
  const next = source[offset + length] ?? "";
  const touchesLeadingWhitespace = previous === "" || /\s/.test(previous);
  const touchesTrailingWhitespace = next === "" || /\s/.test(next);

  // Avoid placeholder spaces when a stripped directive already sits on a
  // whitespace boundary. That prevents fake indentation on later lines while
  // still preserving inline word separation when a tag appears inside prose.
  return touchesLeadingWhitespace || touchesTrailingWhitespace ? "" : " ";
}

function collapseSingleLineDirectiveWhitespace(text: string): string {
  if (text.includes("\n")) {
    // Multiline directive stripping should keep meaningful indentation intact,
    // but still drop trailing horizontal whitespace introduced right before a newline.
    return text.replace(/[ \t]+\n/g, "\n");
  }
  return text.replace(/[^\S\n]+/g, " ");
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
      text,
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
    return stripAudioTag ? getDirectiveReplacement(source, offset, match.length) : match;
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
    return stripReplyTags ? getDirectiveReplacement(source, offset, match.length) : match;
  });

  cleaned = collapseSingleLineDirectiveWhitespace(cleaned.trim());

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
