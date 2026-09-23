import { html, nothing } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";

export function renderSessionActivitySummary(
  row: GatewaySessionRow,
  onRetry?: (row: GatewaySessionRow) => void,
) {
  const summary = row.activitySummary;
  const state =
    summary?.state === "current" && !summary.text ? "missing" : (summary?.state ?? "missing");
  const updating = state === "updating";
  const feedback = updating
    ? ""
    : state === "stale"
      ? t(summary?.text ? "activityFeed.recapStale" : "activityFeed.recapMissing")
      : state === "unavailable"
        ? t(summary?.text ? "activityFeed.recapRefreshFailed" : "activityFeed.recapUnavailable")
        : state === "missing"
          ? t("activityFeed.recapMissing")
          : "";
  return html`<div
    class="activity-feed__recap"
    data-activity-recap=${row.key}
    data-state=${state}
    role="group"
    aria-busy=${String(updating)}
    aria-label=${t("activityFeed.recap")}
    title=${
      summary?.updatedAt
        ? t("activityFeed.recapUpdated", {
            time: formatRelativeTimestamp(summary.updatedAt, { fallback: "" }),
          })
        : nothing
    }
  >
    ${
      summary?.text
        ? html`<p class="activity-feed__recap-text">${summary.text}</p>`
        : updating
          ? html`<div class="activity-feed__recap-skeleton" aria-hidden="true">
              <div class="skeleton skeleton-line skeleton-line--long"></div>
              <div class="skeleton skeleton-line skeleton-line--medium"></div>
            </div>`
          : nothing
    }
    ${
      updating
        ? html`<span class="sr-only" role="status">${t("activityFeed.recapUpdating")}</span>`
        : nothing
    }
    ${
      feedback
        ? html`<div class="activity-feed__recap-feedback">
            <span>${feedback}</span>
            ${
              onRetry &&
              summary?.canEnsure === true &&
              (state === "unavailable" || state === "stale")
                ? html`<button class="activity-feed__recap-retry" @click=${() => onRetry(row)}>
                    ${t("activityFeed.recapRetry")}
                  </button>`
                : nothing
            }
          </div>`
        : nothing
    }
  </div>`;
}
