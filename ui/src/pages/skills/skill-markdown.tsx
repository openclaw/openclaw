import "../../styles/sidebar-markdown.css";
import type { JSX } from "@solidjs/web";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";

export function MarkdownContent(props: {
  content: string;
  changelog?: boolean;
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
  style?: JSX.HTMLAttributes<HTMLElement>["style"];
  onClick?: JSX.EventHandler<HTMLElement, MouseEvent>;
}) {
  return (
    <SanitizedHtml
      tag="article"
      class={["lit-content", props.class]}
      style={props.style}
      onClick={props.onClick}
      html={toSanitizedMarkdownHtml(
        props.content,
        props.changelog ? { codeBlockChrome: "none", mode: "document" } : undefined,
      )}
    />
  );
}
