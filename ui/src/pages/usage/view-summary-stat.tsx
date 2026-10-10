import { t } from "../../lib/reactive/i18n.ts";
import "../../components/tooltip.ts";

function focusSummaryHint(event: MouseEvent) {
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    target.focus();
  }
}

export function renderSummaryStat(params: {
  hintId: string;
  metric: string;
  hint?: string;
  value: string | number;
  sub: string;
  tone?: "good" | "warn" | "bad";
  className?: string;
  compactValue?: boolean;
}) {
  const hintId = `usage-summary-hint-${params.hintId}`;
  const title = t(`usage.overview.${params.metric}`);
  const classes = [
    "stat",
    "usage-summary-card",
    params.className,
    params.tone ? `usage-summary-card--${params.tone}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const valueClasses = [
    "stat-value",
    "usage-summary-value",
    params.tone ?? "",
    params.compactValue ? "usage-summary-value--compact" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div class={classes}>
      <div class="usage-summary-title">
        {title}
        <openclaw-tooltip open-on-click>
          <button
            id={hintId}
            type="button"
            class="usage-summary-hint"
            aria-label={title}
            onClick={focusSummaryHint}
          >
            ?
          </button>
          {/*  Shared tooltips dismiss pointer activation so action buttons never
               strand one open. This hint exists only to be read, so it opts in to
               click-to-open; the click handler still normalizes browsers that do
               not focus buttons on pointer activation.  */}
          <span slot="content">{params.hint ?? t(`usage.overview.${params.metric}Hint`)}</span>
        </openclaw-tooltip>
      </div>
      <div class={valueClasses}>{params.value}</div>
      <div class="usage-summary-sub">{params.sub}</div>
    </div>
  );
}
