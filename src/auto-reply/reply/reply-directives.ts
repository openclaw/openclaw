import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../tokens.js";

export type ReplyDirectiveParseResult = {
  text: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  replyToId?: string;
  replyToCurrent?: boolean;
  replyToTag: boolean;
  reactionEmoji?: string;
  reactionTag: boolean;
  audioAsVoice?: boolean;
  isSilent: boolean;
};

const REACTION_TAG_RE = /\[\[\s*react(?:_to_current)?\s*:\s*([^\]\n]+?)\s*\]\]/gi;

export function parseReplyDirectives(
  raw: string,
  options: { currentMessageId?: string; silentToken?: string } = {},
): ReplyDirectiveParseResult {
  const split = splitMediaFromOutput(raw);
  let text = split.text ?? "";
  let reactionEmoji: string | undefined;
  let reactionTag = false;

  text = text.replace(REACTION_TAG_RE, (_match, emojiRaw: string | undefined) => {
    reactionTag = true;
    const trimmed = emojiRaw?.trim();
    if (trimmed) {
      reactionEmoji = trimmed;
    }
    return " ";
  });

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
    replyToCurrent: replyParsed.replyToCurrent || undefined,
    replyToTag: replyParsed.hasReplyTag,
    reactionEmoji,
    reactionTag,
    audioAsVoice: split.audioAsVoice,
    isSilent,
  };
}
