/** Prepared allowlisted DOM or HTML that has passed the Markdown sanitizer. */
export type MarkdownContent =
  | string
  | { readonly html: string; readonly fragment: DocumentFragment };

export function markdownContentHtml(content: MarkdownContent): string {
  return typeof content === "string" ? content : content.html;
}
