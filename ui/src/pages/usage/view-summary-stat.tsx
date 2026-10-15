import { t } from "../../lib/reactive/i18n.ts";
import "../../components/tooltip.ts";

function focusSummaryHint(event: MouseEvent) {
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    target.focus();
  }
}

export function SummaryStat(props: {
  hintId: string;
  metric: string;
  hint?: string;
  value: string | number;
  sub: string;
  tone?: "good" | "warn" | "bad";
  class?: string;
  compactValue?: boolean;
}) {
  return (
    <div
      class={[
        "stat usage-summary-card",
        props.class,
        props.tone ? `usage-summary-card--${props.tone}` : undefined,
      ]}
    >
      <div class="usage-summary-title">
        {t(`usage.overview.${props.metric}`)}
        <openclaw-tooltip open-on-click>
          <button
            id={`usage-summary-hint-${props.hintId}`}
            type="button"
            class="usage-summary-hint"
            aria-label={t(`usage.overview.${props.metric}`)}
            onClick={focusSummaryHint}
          >
            ?
          </button>
          {/* Summary hints intentionally remain open on pointer activation. */}
          <span slot="content">{props.hint ?? t(`usage.overview.${props.metric}Hint`)}</span>
        </openclaw-tooltip>
      </div>
      <div
        class={[
          "stat-value usage-summary-value",
          props.tone,
          { "usage-summary-value--compact": props.compactValue },
        ]}
      >
        {props.value}
      </div>
      <div class="usage-summary-sub">{props.sub}</div>
    </div>
  );
}
