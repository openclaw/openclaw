import type { HumanMention } from "@openclaw/gateway-protocol";

export type MarkdownHumanMentionToken = { marker: string; profileId: string; label: string };

// Larger message-mode inputs use the literal-text fallback instead of Markdown parsing.
export const MARKDOWN_PARSE_LIMIT = 40_000;

export type MarkdownRenderOptions = {
  assistantTranscriptRoleHeaders?: boolean;
  codeBlockChrome?: "copy" | "none";
  codeBlockInteraction?: "interactive" | "static";
  fileLinks?: boolean;
  fileLinkBasePath?: string;
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

export function normalizeMarkdownRenderOptions(
  options: MarkdownRenderOptions = {},
): MarkdownRenderEnv {
  return {
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders ?? false,
    codeBlockChrome: options.codeBlockChrome ?? "copy",
    codeBlockInteraction: options.codeBlockInteraction ?? "static",
    fileLinks: options.fileLinks ?? false,
    fileLinkBasePath: options.fileLinkBasePath ?? "",
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
