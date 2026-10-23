import type { HumanMention } from "@openclaw/gateway-protocol";
import { i18n } from "../i18n/index.ts";

export type MarkdownHumanMentionToken = { marker: string; profileId: string; label: string };

// Larger message-mode inputs use the literal-text fallback instead of Markdown parsing.
export const MARKDOWN_PARSE_LIMIT = 40_000;

export type MarkdownRenderOptions = {
  assistantTranscriptRoleHeaders?: boolean;
  codeBlockChrome?: "copy" | "none";
  codeBlockInteraction?: "interactive" | "static";
  fileLinks?: boolean;
  humanMentions?: readonly HumanMention[];
  interactiveImages?: boolean;
  linkFavicons?: boolean;
  progressBars?: boolean;
  mode?: "document" | "message";
  remoteImages?: boolean;
  sessionLinks?: boolean;
  tableInteractions?: "enabled" | "none";
};

export type MarkdownRenderEnv = Required<MarkdownRenderOptions> & {
  streamingOpenFence?: boolean;
  humanMentionTokens?: readonly MarkdownHumanMentionToken[];
};

export function markdownRenderKey(options: MarkdownRenderEnv): string {
  return `${i18n.getLocale()}\0${options.assistantTranscriptRoleHeaders}\0${options.codeBlockChrome}\0${options.codeBlockInteraction}\0${options.fileLinks}\0${options.interactiveImages}\0${options.linkFavicons}\0${options.progressBars}\0${options.mode}\0${options.remoteImages}\0${options.sessionLinks}\0${options.tableInteractions}\0${JSON.stringify(options.humanMentionTokens ?? [])}`;
}

export function normalizeMarkdownRenderOptions(
  options: MarkdownRenderOptions = {},
): MarkdownRenderEnv {
  return {
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders ?? false,
    codeBlockChrome: options.codeBlockChrome ?? "copy",
    codeBlockInteraction: options.codeBlockInteraction ?? "static",
    fileLinks: options.fileLinks ?? false,
    humanMentions: options.humanMentions ?? [],
    interactiveImages: options.interactiveImages ?? false,
    linkFavicons: options.linkFavicons ?? false,
    progressBars: options.progressBars ?? false,
    mode: options.mode ?? "message",
    remoteImages: options.remoteImages ?? options.mode === "document",
    sessionLinks: options.sessionLinks ?? false,
    tableInteractions: options.tableInteractions ?? "none",
  };
}
