import { Show, createMemo } from "solid-js";
import { summarizeAgentActivity } from "../../../../../src/agents/agent-activity-presentation.js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { resolveToolApprovalReviewOutcome } from "../../../lib/chat/tool-approval-reviews.ts";
import { isToolCardError, isToolCardSkipped } from "../../../lib/chat/tool-cards.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../../lit/solid-bridge.ts";

export type ToolOutcomeSummaryProps = {
  cards: readonly ToolCard[];
  includeCount?: boolean;
  activity?: Parameters<typeof summarizeAgentActivity>[0];
};

/** Status belongs in the disclosure; diagnostics stay in the expanded tool output. */
export function ToolOutcomeSummary(props: ToolOutcomeSummaryProps) {
  const failures = createMemo(() => props.cards.filter(isToolCardError));
  const outcomes = createMemo(() =>
    props.activity ? summarizeAgentActivity(props.activity).outcomes : undefined,
  );
  const failureCount = () => outcomes()?.failed ?? failures().length;
  const skipped = () => outcomes()?.skipped ?? props.cards.filter(isToolCardSkipped).length;
  const outcome = () =>
    failures()[0]?.exitCode === undefined
      ? t("chat.toolCards.failed")
      : t("chat.toolCards.exitCode", { code: String(failures()[0]!.exitCode) });
  return (
    <>
      <Show when={failureCount() > 0}>
        <span class="chat-tool-failure">
          {props.includeCount !== false
            ? t("chat.toolCards.failureCount", { count: String(failureCount()) })
            : outcome()}
        </span>
      </Show>
      <Show when={skipped() > 0}>
        <span class="chat-tool-skipped">
          {props.includeCount !== false
            ? t("chat.toolCards.skippedCount", { count: String(skipped()) })
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

export const ToolOutcomeSummaryHost = defineSolidBridge<ToolOutcomeSummaryProps>(
  "openclaw-chat-tool-outcome-summary",
  (props) => (
    <ToolOutcomeSummary
      cards={props.cards}
      includeCount={props.includeCount}
      activity={props.activity}
    />
  ),
  {
    properties: {
      cards: { default: [], attribute: false },
      includeCount: { default: true, attribute: false },
      activity: { default: undefined, attribute: false },
    },
  },
);
export const ToolReviewOutcomeHost = defineSolidBridge<{
  outcome: ReviewOutcome;
  reviewer: string;
}>(
  "openclaw-chat-tool-review-outcome",
  (props) => <ToolReviewOutcome outcome={props.outcome} reviewer={props.reviewer} />,
  {
    properties: {
      outcome: { default: null, attribute: false },
      reviewer: { default: "Review", attribute: false },
    },
  },
);
