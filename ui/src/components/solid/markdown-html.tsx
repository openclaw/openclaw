import { dynamic, type JSX } from "@solidjs/web";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { handleMarkdownCodeBlockClick } from "../markdown-code-blocks.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";

export function MarkdownHtml(props: {
  markdown: string;
  class?: string;
  dir?: "ltr" | "rtl" | "auto";
  style?: JSX.CSSProperties | string;
  as?: "div" | "p" | "article";
  options?: Parameters<typeof toSanitizedMarkdownHtml>[1];
  ref?: (element: HTMLElement) => void;
}) {
  const Tag = dynamic(() => props.as ?? "div");
  return (
    <Tag
      ref={[
        props.ref,
        nativeListener("click", (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(".code-block-wrapper button")
          ) {
            // Keep an enclosing Markdown host from handling the same control twice.
            event.stopPropagation();
            handleMarkdownCodeBlockClick(event);
          }
        }),
      ]}
      class={props.class}
      dir={props.dir}
      style={props.style}
      // oxlint-disable-next-line solid/no-innerhtml -- The shared Markdown renderer sanitizes this sole HTML sink.
      innerHTML={toSanitizedMarkdownHtml(props.markdown, props.options)}
    />
  );
}
