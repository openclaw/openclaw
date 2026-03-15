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

/** Extract STICKER: directives from text, removing them from the output text. Case-insensitive. Only first sticker is used. */
function extractStickerDirective(text: string): { text: string; sticker?: { raw: string } } {
  const lines = text.split("\n");
  let sticker: { raw: string } | undefined;
  const remaining: string[] = [];

  for (const line of lines) {
    if (/^sticker:/i.test(line.trim())) {
      if (!sticker) {
        const raw = line.slice(line.toLowerCase().indexOf("sticker:") + "sticker:".length).trim();
        if (raw) {
          sticker = { raw };
        }
      }
      // Drop STICKER: lines from the output text
    } else {
      remaining.push(line);
    }
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
