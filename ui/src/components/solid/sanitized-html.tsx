import { untrack } from "solid-js";

/** Only accepts HTML escaped or sanitized by the caller's content owner. */
export function SanitizedHtml(props: { html: string; tag: "code" | "div"; class?: string }) {
  const tag = untrack(() => props.tag);
  return (
    <>
      {tag === "code" ? (
        // eslint-disable-next-line solid/no-innerhtml -- Highlighted code is escaped by highlightCodeHtml.
        <code class={props.class} innerHTML={props.html} />
      ) : (
        // eslint-disable-next-line solid/no-innerhtml -- Markdown is sanitized by toSanitizedMarkdownHtml.
        <div class={props.class} innerHTML={props.html} />
      )}
    </>
  );
}
