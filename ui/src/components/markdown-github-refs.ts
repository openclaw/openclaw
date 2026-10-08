import { createMarkdownGitHubRefsInstaller } from "@openclaw/github/control-ui-markdown-api.js";
import { hasMarkdownLinkBoundaries } from "./markdown-link-boundary.ts";
import { replaceMarkdownTextMatches } from "./markdown-text-replacements.ts";

export const installMarkdownGitHubRefs = createMarkdownGitHubRefsInstaller({
  hasMarkdownLinkBoundaries,
  replaceMarkdownTextMatches,
});
