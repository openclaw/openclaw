// Helpers for resolving the text payload of a code-block "Copy" button click.
//
// The rendered DOM looks like:
//   <div class="code-block-wrapper">
//     <div class="code-block-header">
//       <span class="code-block-lang">js</span>
//       <button class="code-block-copy" data-code="...">Copy</button>
//     </div>
//     <pre><code class="language-js">...</code></pre>
//   </div>
//
// Reading from the rendered <code>'s textContent is the most reliable source —
// it always matches what the user sees, even when `data-code` was stripped by
// sanitization, normalized differently across browsers, or simply empty.
// The `data-code` attribute remains a fallback for the (rare) case where the
// wrapper or rendered <code> element cannot be located, e.g. partial DOMs in
// tests or non-default markdown rendering.

export function resolveCodeBlockCopyText(btn: Element | null | undefined): string {
  if (!btn) {
    return "";
  }
  const wrapper = btn.closest(".code-block-wrapper");
  const codeEl = wrapper?.querySelector("pre > code");
  const fromDom = codeEl?.textContent;
  if (fromDom !== null && fromDom !== undefined) {
    return fromDom;
  }
  return (btn as HTMLElement).dataset?.code ?? "";
}
