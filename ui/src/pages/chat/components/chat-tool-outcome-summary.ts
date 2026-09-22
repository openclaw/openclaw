import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { isToolCardError, isToolCardSkipped } from "../../../lib/chat/tool-cards.ts";

/** Status belongs in the disclosure; diagnostics stay in the expanded tool output. */
export function renderToolOutcomeSummary(cards: readonly ToolCard[], includeCount = true) {
  const failures = cards.filter(isToolCardError);
  const skipped = cards.filter(isToolCardSkipped).length;
  const first = failures[0];
  if (!first && skipped === 0) {
    return nothing;
  }
  const outcome =
    first?.exitCode === undefined
      ? t("chat.toolCards.failed")
      : t("chat.toolCards.exitCode", { code: String(first.exitCode) });
  return html`${
    first
      ? html`<span class="chat-tool-failure"
          >${
            includeCount
              ? t("chat.toolCards.failureCount", { count: String(failures.length) })
              : outcome
          }</span
        >`
      : nothing
  }${
    skipped > 0
      ? html`<span class="chat-tool-skipped"
          >${
            includeCount
              ? t("chat.toolCards.skippedCount", { count: String(skipped) })
              : t("chat.toolCards.skipped")
          }</span
        >`
      : nothing
  }`;
}
