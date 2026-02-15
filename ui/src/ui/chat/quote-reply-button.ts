import { html, type TemplateResult } from "lit";
import { icons } from "../icons.ts";

const QUOTE_LABEL = "Quote reply";

type QuoteReplyButtonOptions = {
  text: () => string;
  onQuote: (quoted: string) => void;
};

export function renderQuoteReplyButton(
  markdown: string,
  onQuote: (quoted: string) => void,
): TemplateResult {
  return html`
    <button
      class="chat-quote-btn"
      type="button"
      title=${QUOTE_LABEL}
      aria-label=${QUOTE_LABEL}
      @click=${(e: Event) => {
        e.preventDefault();
        const lines = markdown.split("\n");
        const quoted = lines.map((line) => `> ${line}`).join("\n");
        onQuote(`${quoted}\n\n`);
      }}
    >
      <span class="chat-quote-btn__icon" aria-hidden="true">
        ${icons.messageSquare}
      </span>
    </button>
  `;
}
