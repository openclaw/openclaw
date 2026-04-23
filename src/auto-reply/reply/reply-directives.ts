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
};

export function parseReplyDirectives(
  raw: string,
  options: { currentMessageId?: string; silentToken?: string } = {},
): ReplyDirectiveParseResult {
  // Strip reply tags before media extraction so directives like
  // `[[reply_to_current]] MEDIA:./file.png` still parse both pieces correctly.
  const replyParsed = parseInlineDirectives(raw, {
    currentMessageId: options.currentMessageId,
    stripAudioTag: false,
    stripReplyTags: true,
  });

  const preStripped = replyParsed.hasReplyTag ? replyParsed.text : raw;
  const split = splitMediaFromOutput(preStripped);
  let text = split.text ?? "";

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
  };
}
