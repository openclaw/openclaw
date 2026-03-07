import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

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
  const split = splitMediaFromOutput(raw);
  let text = split.text ?? "";

  const replyParsed = parseInlineDirectives(text, {
    currentMessageId: options.currentMessageId,
    stripAudioTag: false,
    stripReplyTags: true,
  });

  if (replyParsed.hasReplyTag) {
    text = replyParsed.text;
  }

  // Strip stray end-of-sequence tokens that may leak from model output
  text = text.replace(/<\/s>\s*$/g, "").trimEnd();

  // Strip self-talk: model fabricating conversation turn tags.
  // Truncate at the first occurrence of a conversation tag and
  // remove everything after it (hallucinated user/assistant turns).
  text = text.replace(/\n*<\/?(?:user|assistant)>[\s\S]*$/g, "").trimEnd();

  const silentToken = options.silentToken ?? SILENT_REPLY_TOKEN;
  const isSilent = isSilentReplyText(text, silentToken);
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
