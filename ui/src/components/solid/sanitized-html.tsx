/** The caller must supply HTML from the shared sanitizer. */
export function SanitizedHtml(props: { html: string; class?: string }) {
  // eslint-disable-next-line solid/no-innerhtml -- This boundary only accepts already-sanitized HTML.
  return <div class={props.class} innerHTML={props.html} />;
}
