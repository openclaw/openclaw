import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { resolveToolApprovalReviewOutcome } from "../../../lib/chat/tool-approval-reviews.ts";
import { isToolCardError, isToolCardSkipped } from "../../../lib/chat/tool-cards.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatToolLabelsEnglish);

/**
 * One operation's own outcome. Nested calls keep theirs on their own rows:
 * an agent recovers from routine failures, so a step or group never tallies them.
 */
export function ToolOutcomeSummary(props: { card: ToolCard }) {
  const exitCode = () => props.card.exitCode;
  return (
    <>
      <Show when={isToolCardError(props.card)}>
        <span class="chat-tool-failure">
          {exitCode() === undefined || exitCode() === 0
            ? t("chat.toolCards.failed")
            : t("chat.toolCards.exitCode", { code: String(exitCode()) })}
        </span>
      </Show>
      <Show when={isToolCardSkipped(props.card)}>
        <span class="chat-tool-skipped">{t("chat.toolCards.skipped")}</span>
      </Show>
    </>
  );
}

type ReviewOutcome = ReturnType<typeof resolveToolApprovalReviewOutcome>;
export function ToolReviewOutcome(props: { outcome: ReviewOutcome; reviewer?: string }) {
  return (
    <Show when={props.outcome}>
      <span
        class="chat-activity-group__review-status"
        data-outcome={props.outcome}
        role="img"
        aria-label={t(`chat.toolCards.review.${props.outcome}`, {
          reviewer: props.reviewer ?? "Review",
        })}
      >
        <Icon
          name={
            props.outcome === "denied"
              ? "shieldX"
              : props.outcome === "reviewing"
                ? "shieldQuestion"
                : "shieldCheck"
          }
        />
      </span>
    </Show>
  );
}
