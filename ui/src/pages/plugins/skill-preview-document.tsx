import { stripFrontmatterBlock } from "../../../../packages/markdown-core/src/frontmatter.js";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import "../../styles/sidebar-markdown.css";

export function PluginSkillDocument(props: { content: string }) {
  return (
    <SanitizedHtml
      tag="article"
      class="sidebar-markdown"
      html={toSanitizedMarkdownHtml(stripFrontmatterBlock(props.content), {
        mode: "document",
        remoteImages: false,
        codeBlockChrome: "none",
        relativeLinks: false,
      })}
    />
  );
}
