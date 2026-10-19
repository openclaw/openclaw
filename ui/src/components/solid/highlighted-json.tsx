import DOMPurify from "dompurify";
import { createMemo } from "solid-js";
import { highlightJsonHtml } from "../markdown-code-blocks.ts";
import { SanitizedHtml } from "./sanitized-html.tsx";

/** The highlighter owns markup; only its span/class vocabulary reaches the DOM. */
export function HighlightedJson(props: { value: unknown; class?: string }) {
  const markup = createMemo(() =>
    DOMPurify.sanitize(highlightJsonHtml(JSON.stringify(props.value, null, 2)), {
      ALLOWED_TAGS: ["span"],
      ALLOWED_ATTR: ["class"],
    }),
  );
  return <SanitizedHtml tag="pre" class={props.class} html={markup()} />;
}
