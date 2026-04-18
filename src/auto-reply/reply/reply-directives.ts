import { parseFenceSpans } from "../../markdown/fences.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../tokens.js";

export type ReplyDirectiveParseResult = {
  text: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  replyToId?: string;
  replyToCurrent: boolean;
  replyToTag: boolean;
  audioAsVoice?: boolean;
  isSilent: boolean;
  /** Sticker directive extracted from the text. Raw value is channel-agnostic. */
  sticker?: { raw: string };
};

/**
 * Extract STICKER: directives from text. Valid non-empty directives are removed
 * from output text, while empty directives are kept as plain text.
 */
function extractStickerDirective(text: string): { text: string; sticker?: { raw: string } } {
  const hasFenceMarkers = text.includes("```") || text.includes("~~~");
  const fenceSpans = hasFenceMarkers ? parseFenceSpans(text) : [];
  const lines = text.split("\n");
  let sticker: { raw: string } | undefined;
  const remaining: string[] = [];
  let lineOffset = 0;

  for (const line of lines) {
    const isInsideFence =
      hasFenceMarkers &&
      fenceSpans.some((span) => lineOffset >= span.start && lineOffset < span.end);
    if (isInsideFence) {
      remaining.push(line);
      lineOffset += line.length + 1;
      continue;
    }

    const trimmed = line.trim();
    if (!/^sticker:/i.test(trimmed)) {
      remaining.push(line);
      lineOffset += line.length + 1;
      continue;
    }
    const raw = trimmed.slice(trimmed.toLowerCase().indexOf("sticker:") + "sticker:".length).trim();
    if (raw && !/\s/.test(raw)) {
      if (!sticker) {
        sticker = { raw };
      }
      lineOffset += line.length + 1;
      continue;
    }
    // Keep empty STICKER: directives visible so malformed output is not silently dropped.
    remaining.push(line);
    lineOffset += line.length + 1;
  }

  return { text: remaining.join("\n"), sticker };
}

export function parseReplyDirectives(
  raw: string,
  options: { currentMessageId?: string; silentToken?: string } = {},
): ReplyDirectiveParseResult {
  const split = splitMediaFromOutput(raw);
  const { text: textAfterSticker, sticker } = extractStickerDirective(split.text ?? "");
  let text = textAfterSticker;

  const replyParsed = parseInlineDirectives(text, {
    currentMessageId: options.currentMessageId,
    stripAudioTag: false,
    stripReplyTags: true,
  });

  if (replyParsed.hasReplyTag) {
    text = replyParsed.text;
  }

  const silentToken = options.silentToken ?? SILENT_REPLY_TOKEN;
  const isSilent = isSilentReplyPayloadText(text, silentToken);
  if (isSilent) {
    text = "";
  }

  return {
    text,
    mediaUrls: split.mediaUrls,
    mediaUrl: split.mediaUrl,
    replyToId: replyParsed.replyToId,
    replyToCurrent: replyParsed.replyToCurrent,
    replyToTag: replyParsed.hasReplyTag,
    audioAsVoice: split.audioAsVoice,
    isSilent,
    sticker,
  };
}
