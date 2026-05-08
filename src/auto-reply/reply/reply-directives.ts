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
  audioAsVoice?: boolean;
  isSilent: boolean;
};

export type MediaDirectiveParseMode = "extract" | "strip" | "ignore";

export type ReplyDirectiveParseOptions = {
  currentMessageId?: string;
  silentToken?: string;
  extractMarkdownImages?: boolean;
  /**
   * Raw textual MEDIA: lines are authority-bearing only at final-reply boundaries.
   * Use "strip" for tool/log/diagnostic text that should be rendered without
   * activating raw media directives, and "ignore" when MEDIA-looking text
   * should remain visible.
   */
  mediaDirectives?: MediaDirectiveParseMode;
};

export function parseReplyDirectives(
  raw: string,
  options: ReplyDirectiveParseOptions = {},
): ReplyDirectiveParseResult {
  const mediaDirectiveMode = options.mediaDirectives ?? "extract";
  const split = (() => {
    if (mediaDirectiveMode === "ignore") {
      return { text: raw };
    }
    if (mediaDirectiveMode === "strip") {
      const stripped = splitMediaFromOutput(raw, { extractMarkdownImages: false });
      if (options.extractMarkdownImages !== true) {
        return { text: stripped.text };
      }
      return splitMediaFromOutput(stripped.text, { extractMarkdownImages: true });
    }
    return splitMediaFromOutput(raw, {
      extractMarkdownImages: options.extractMarkdownImages,
    });
  })();
  let text = split.text ?? "";

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

  const exposeMediaDirectives =
    mediaDirectiveMode === "extract" ||
    (mediaDirectiveMode === "strip" && options.extractMarkdownImages === true);
  return {
    text,
    mediaUrls: exposeMediaDirectives ? split.mediaUrls : undefined,
    mediaUrl: exposeMediaDirectives ? split.mediaUrl : undefined,
    replyToId: replyParsed.replyToId,
    replyToCurrent: replyParsed.replyToCurrent || undefined,
    replyToTag: replyParsed.hasReplyTag,
    audioAsVoice: mediaDirectiveMode === "extract" ? split.audioAsVoice : undefined,
    isSilent,
  };
}
