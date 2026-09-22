import { html, nothing } from "lit";
import { summarizeAgentActivity } from "../../../../../src/agents/agent-activity-presentation.js";
import { t } from "../../../i18n/index.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { isToolCardError, isToolCardSkipped } from "../../../lib/chat/tool-cards.ts";

/** Status belongs in the disclosure; diagnostics stay in the expanded tool output. */
export function renderToolOutcomeSummary(
  cards: readonly ToolCard[],
  includeCount = true,
  activity?: Parameters<typeof summarizeAgentActivity>[0],
) {
  const failures = cards.filter(isToolCardError);
  // Prepared outcomes remain authoritative even when their raw card is absent.
  const failureCount = activity
    ? summarizeAgentActivity(activity).outcomes.failed
    : failures.length;
  const skipped = cards.filter(isToolCardSkipped).length;
  const first = failures[0];
  if (failureCount === 0 && skipped === 0) {
    return nothing;
  }
  const outcome =
    first?.exitCode === undefined
      ? t("chat.toolCards.failed")
      : t("chat.toolCards.exitCode", { code: String(first.exitCode) });
  return html`${
    failureCount > 0
      ? html`<span class="chat-tool-failure"
          >${
            includeCount
              ? t("chat.toolCards.failureCount", { count: String(failureCount) })
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
