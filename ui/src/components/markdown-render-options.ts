import type { HumanMention } from "@openclaw/gateway-protocol";
import type {
  MarkdownGitHubRepository,
  MarkdownGitHubRepositoryAliases,
} from "./markdown-github-repositories.ts";

export type MarkdownHumanMentionToken = { marker: string; profileId: string; label: string };

// Larger message-mode inputs use the literal-text fallback instead of Markdown parsing.
export const MARKDOWN_PARSE_LIMIT = 40_000;

type MarkdownCodeBlockChrome = "copy" | "none";
type MarkdownCodeBlockInteraction = "interactive" | "static";
type MarkdownTableInteractions = "enabled" | "none";
type MarkdownRenderMode = "document" | "message";

export type MarkdownRenderOptions = {
  assistantTranscriptRoleHeaders?: boolean;
  codeBlockChrome?: MarkdownCodeBlockChrome;
  codeBlockInteraction?: MarkdownCodeBlockInteraction;
  fileLinks?: boolean;
  githubRepo?: MarkdownGitHubRepository | null;
  githubRepositories?: readonly MarkdownGitHubRepositoryAliases[];
  humanMentions?: readonly HumanMention[];
  interactiveImages?: boolean;
  linkFavicons?: boolean;
  progressBars?: boolean;
  mode?: MarkdownRenderMode;
  remoteImages?: boolean;
  sessionLinks?: boolean;
  tableInteractions?: MarkdownTableInteractions;
};

export type MarkdownGitHubContext = Pick<
  MarkdownRenderOptions,
  "githubRepo" | "githubRepositories"
>;

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
    githubRepo: options.githubRepo ?? null,
    humanMentions: options.humanMentions ?? [],
    githubRepositories: options.githubRepositories ?? [],
    interactiveImages: options.interactiveImages ?? false,
    linkFavicons: options.linkFavicons ?? false,
    progressBars: options.progressBars ?? false,
    mode: options.mode ?? "message",
    remoteImages: options.remoteImages ?? options.mode === "document",
    sessionLinks: options.sessionLinks ?? false,
    tableInteractions: options.tableInteractions ?? "none",
  };
}
