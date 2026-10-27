import { Show, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { resolveToolApprovalReviewOutcome } from "../../../lib/chat/tool-approval-reviews.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { summarizeToolCardOutcomes } from "./chat-tool-render-model.ts";

registerEnglishCatalog(registerChatToolLabelsEnglish);

/** Status belongs in the disclosure; diagnostics stay in the expanded tool output. */
export function ToolOutcomeSummary(props: {
  cards: readonly ToolCard[];
  includeCount?: boolean;
  activity?: Parameters<typeof summarizeToolCardOutcomes>[1];
}) {
  const outcomes = createMemo(() => summarizeToolCardOutcomes(props.cards, props.activity));
  const outcome = () =>
    outcomes().exitCode === undefined || outcomes().exitCode === 0
      ? t("chat.toolCards.failed")
      : t("chat.toolCards.exitCode", { code: String(outcomes().exitCode) });
  return (
    <>
      <Show when={outcomes().failed > 0}>
        <span class="chat-tool-failure">
          {props.includeCount !== false
            ? t("chat.toolCards.failureCount", { count: String(outcomes().failed) })
            : outcome()}
        </span>
      </Show>
      <Show when={outcomes().skipped > 0}>
        <span class="chat-tool-skipped">
          {props.includeCount !== false
            ? t("chat.toolCards.skippedCount", { count: String(outcomes().skipped) })
            : t("chat.toolCards.skipped")}
        </span>
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
