import { html } from "lit";
import "../styles/mention-excerpt.css";

/** Highlight only the producer's selected span; this is text, not a profile link. */
export function renderMentionExcerpt(text: string, mention?: { start: number; end: number }) {
  if (
    !mention ||
    !Number.isSafeInteger(mention.start) ||
    !Number.isSafeInteger(mention.end) ||
    mention.start < 0 ||
    mention.end <= mention.start ||
    mention.end > text.length
  ) {
    return text;
  }
  return html`${text.slice(0, mention.start)}<span class="mention-excerpt__highlight"
      >${text.slice(mention.start, mention.end)}</span
    >${text.slice(mention.end)}`;
}
