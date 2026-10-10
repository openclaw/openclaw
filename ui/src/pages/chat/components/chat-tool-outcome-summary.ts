import { html, nothing } from "lit";
import { summarizeAgentActivity } from "../../../../../src/agents/agent-activity-presentation.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { resolveToolApprovalReviewOutcome } from "../../../lib/chat/tool-approval-reviews.ts";
import { isToolCardError, isToolCardSkipped } from "../../../lib/chat/tool-cards.ts";

/** Status belongs in the disclosure; diagnostics stay in the expanded tool output. */
export function renderToolOutcomeSummary(
  cards: readonly ToolCard[],
  includeCount = true,
  activity?: Parameters<typeof summarizeAgentActivity>[0],
) {
  const failures = cards.filter(isToolCardError);
  // Prepared outcomes remain authoritative even when their raw card is absent.
  const outcomes = activity ? summarizeAgentActivity(activity).outcomes : undefined;
  const failureCount = outcomes?.failed ?? failures.length;
  const skipped = outcomes?.skipped ?? cards.filter(isToolCardSkipped).length;
  const first = failures[0];
  if (failureCount === 0 && skipped === 0) {
    return nothing;
  }
  const outcome =
    first?.exitCode === undefined
      ? t("chat.toolCards.failed")
      : t("chat.toolCards.exitCode", { code: String(first.exitCode) });
  const renderCount = (kind: "failure" | "skipped", count: number) =>
    count > 0
      ? html`<span class="chat-tool-${kind}"
          >${
            includeCount
              ? t(`chat.toolCards.${kind}Count`, { count: String(count) })
              : kind === "failure"
                ? outcome
                : t("chat.toolCards.skipped")
          }</span
        >`
      : nothing;
  return html`${renderCount("failure", failureCount)}${renderCount("skipped", skipped)}`;
}

/** The approval verdict for a disclosure whose calls were reviewed. */
export function renderToolReviewOutcome(
  outcome: ReturnType<typeof resolveToolApprovalReviewOutcome>,
  reviewer = "Review",
) {
  return outcome
    ? html`<span
        class="chat-activity-group__review-status"
        data-outcome=${outcome}
        role="img"
        aria-label=${t(`chat.toolCards.review.${outcome}`, { reviewer })}
        >${
          outcome === "denied"
            ? icons.shieldX
            : outcome === "reviewing"
              ? icons.shieldQuestion
              : icons.shieldCheck
        }</span
      >`
    : nothing;
}
