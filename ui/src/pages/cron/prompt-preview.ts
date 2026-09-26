// Read-only Markdown preview for the agent-turn automation prompt. Prompts are edited as
// plain text but run through Markdown rendering when the agent posts them, so this is the
// only way to see how headings/lists will actually look without saving and triggering a run.
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { t } from "../../i18n/index.ts";

export function renderPromptPreview(
  ctx: { isAgentTurn: boolean; payloadLocked: boolean },
  payloadText: string,
) {
  if (!ctx.isAgentTurn || ctx.payloadLocked || !payloadText.trim()) {
    return nothing;
  }
  return html`
    <details class="cron-payload-preview">
      <summary class="cron-payload-preview__summary">${t("cron.form.promptPreview")}</summary>
      <div class="cron-payload-preview__body chat-text">
        ${unsafeHTML(toSanitizedMarkdownHtml(payloadText))}
      </div>
    </details>
  `;
}
