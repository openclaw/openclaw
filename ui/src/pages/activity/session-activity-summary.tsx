import { createMemo } from "@solidjs/signals";
import type { GatewaySessionRow } from "../../api/types.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";

type SessionActivitySummaryProps = {
  row: GatewaySessionRow;
  onRetry?: (row: GatewaySessionRow) => void;
};

export function renderSessionActivitySummary(props: SessionActivitySummaryProps) {
  const summary = () => props.row.activitySummary;
  const state = createMemo(() =>
    summary()?.state === "current" && !summary()?.text
      ? "missing"
      : (summary()?.state ?? "missing"),
  );
  const updating = () => state() === "updating";
  const feedback = createMemo(() =>
    state() === "stale"
      ? t(summary()?.text ? "activityFeed.recapStale" : "activityFeed.recapMissing")
      : state() === "unavailable"
        ? t(summary()?.text ? "activityFeed.recapRefreshFailed" : "activityFeed.recapUnavailable")
        : state() === "missing"
          ? t("activityFeed.recapMissing")
          : "",
  );
  const title = createMemo(() => {
    const updatedAt = summary()?.updatedAt;
    return updatedAt
      ? t("activityFeed.recapUpdated", {
          time: formatRelativeTimestamp(updatedAt, { fallback: "" }),
        })
      : undefined;
  });
  return (
    <div
      class="activity-feed__recap"
      data-activity-recap={props.row.key}
      data-state={state()}
      role="group"
      aria-busy={updating() ? "true" : "false"}
      aria-label={t("activityFeed.recap")}
      title={title()}
    >
      {summary()?.text ? (
        <p class="activity-feed__recap-text">{summary()?.text}</p>
      ) : updating() ? (
        <div class="activity-feed__recap-skeleton" aria-hidden="true">
          <div class="skeleton skeleton-line skeleton-line--long" />
          <div class="skeleton skeleton-line skeleton-line--medium" />
        </div>
      ) : undefined}
      {updating() ? (
        <span class="sr-only" role="status">
          {t("activityFeed.recapUpdating")}
        </span>
      ) : undefined}
      {feedback() ? (
        <div class="activity-feed__note">
          <span>{feedback()}</span>
          {props.onRetry &&
          summary()?.canEnsure === true &&
          (state() === "unavailable" || state() === "stale") ? (
            <button class="activity-feed__note-action" onClick={() => props.onRetry?.(props.row)}>
              {t("activityFeed.recapRetry")}
            </button>
          ) : undefined}
        </div>
      ) : undefined}
    </div>
  );
}
