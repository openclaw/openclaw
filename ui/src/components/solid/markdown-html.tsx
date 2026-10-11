import { dynamic, type JSX } from "@solidjs/web";
import { toSanitizedMarkdownHtml } from "../markdown.ts";

export function MarkdownHtml(props: {
  markdown: string;
  class?: string;
  style?: JSX.CSSProperties | string;
  as?: "div" | "p" | "article";
  options?: Parameters<typeof toSanitizedMarkdownHtml>[1];
}) {
  const Tag = dynamic(() => props.as ?? "div");
  return (
    <Tag
      class={props.class}
      style={props.style}
      // oxlint-disable-next-line solid/no-innerhtml -- The shared Markdown renderer sanitizes this sole HTML sink.
      innerHTML={toSanitizedMarkdownHtml(props.markdown, props.options)}
    />
  );
}
