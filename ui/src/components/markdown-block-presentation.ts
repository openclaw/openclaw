/** Parked transcript rows retain controls without doing foreground Markdown work. */
export function isMarkdownBlockParked(element: Element): boolean {
  return Boolean(element.closest(".chat-virtual-row[data-prepared-row]:not([data-preparing-row])"));
}
