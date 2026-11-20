import { stripFrontmatterBlock } from "../../../../packages/markdown-core/src/frontmatter.js";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";

export function renderPluginSkillDocument(content: string): string {
  return toSanitizedMarkdownHtml(stripFrontmatterBlock(content), {
    mode: "document",
    remoteImages: false,
    codeBlockChrome: "none",
    relativeLinks: false,
  });
}
