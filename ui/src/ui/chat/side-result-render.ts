import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../icons.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import { detectTextDirection } from "../text-direction.ts";
import { viDashboardText as uiText } from "../vi-dashboard-text.ts";
import type { ChatSideResult } from "./side-result.ts";

export function renderSideResult(
  sideResult: ChatSideResult | null | undefined,
  onDismiss?: () => void,
): TemplateResult | typeof nothing {
  if (!sideResult) {
    return nothing;
  }
  return html`
    <section
      class=${`chat-side-result ${sideResult.isError ? "chat-side-result--error" : ""}`}
      role="status"
      aria-live="polite"
      aria-label=${uiText("BTW side result", "Kết quả phụ BTW")}
    >
      <div class="chat-side-result__header">
        <div class="chat-side-result__label-row">
          <span class="chat-side-result__label">BTW</span>
          <span class="chat-side-result__meta"
            >${uiText("Not saved to chat history", "Không lưu vào lịch sử chat")}</span
          >
        </div>
        <button
          class="btn chat-side-result__dismiss"
          type="button"
          aria-label=${uiText("Dismiss BTW result", "Bỏ qua kết quả BTW")}
          title=${uiText("Dismiss", "Bỏ qua")}
          @click=${() => onDismiss?.()}
        >
          ${icons.x}
        </button>
      </div>
      <div class="chat-side-result__question">${sideResult.question}</div>
      <div class="chat-side-result__body" dir=${detectTextDirection(sideResult.text)}>
        ${unsafeHTML(toSanitizedMarkdownHtml(sideResult.text))}
      </div>
    </section>
  `;
}
