import path from "node:path";
import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

/**
 * Resolve a relative media path (starting with ./) to an absolute path.
 * This must be called while process.cwd() is the workspace directory,
 * as delivery happens asynchronously when cwd may have changed.
 */
function resolveMediaPath(mediaUrl: string): string {
  if (mediaUrl.startsWith("./")) {
    return path.resolve(mediaUrl);
  }
  return mediaUrl;
}

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
  options: { currentMessageId?: string; silentToken?: string; resolveRelativePaths?: boolean } = {},
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

  const silentToken = options.silentToken ?? SILENT_REPLY_TOKEN;
  const isSilent = isSilentReplyText(text, silentToken);
  if (isSilent) {
    text = "";
  }

  // Resolve relative paths to absolute while cwd is still the workspace.
  // Delivery happens asynchronously when cwd may have been restored.
  // Only enabled when the caller is in the agent-runner context (resolveRelativePaths: true).
  const resolve = options.resolveRelativePaths ? resolveMediaPath : (u: string) => u;
  const resolvedMediaUrls = split.mediaUrls?.map(resolve);
  const resolvedMediaUrl = split.mediaUrl ? resolve(split.mediaUrl) : undefined;

  return {
    text,
    mediaUrls: resolvedMediaUrls,
    mediaUrl: resolvedMediaUrl,
    replyToId: replyParsed.replyToId,
    replyToCurrent: replyParsed.replyToCurrent,
    replyToTag: replyParsed.hasReplyTag,
    audioAsVoice: split.audioAsVoice,
    isSilent,
  };
}
