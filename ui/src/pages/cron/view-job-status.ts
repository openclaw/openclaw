import { html } from "lit";
import type { CronJob } from "../../api/types.ts";
import { icon, type IconName } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import {
  isCronJobActiveFailure,
  isCronJobRunning,
  resolveCronJobLastRunStatus,
} from "../../lib/cron-status.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { runStatusLabel } from "./view-runs.ts";

export function renderJobStateIndicator(job: CronJob) {
  const autoDisabled = job.state?.autoDisabled;
  const [state, iconName, label]: [string, IconName | null, string] = isCronJobRunning(job)
    ? ["running", "loader", t("cron.runs.runStatusRunning")]
    : autoDisabled
      ? ["error", "lock", disabledNoteLabel(autoDisabled)]
      : isCronJobActiveFailure(job)
        ? ["error", "alertTriangle", t("cron.runs.runStatusError")]
        : !job.enabled
          ? ["paused", "pause", t("cron.list.paused")]
          : ["active", null, t("cron.detail.active")];
  return html`<span
    class="cron-table__state cron-table__state--${state}"
    role="img"
    aria-label=${label}
    title=${label}
    >${iconName ? icon(iconName) : html`<span class="cron-table__state-dot"></span>`}</span
  >`;
}

export function renderTriggerIndicator() {
  const label = t("cron.form.triggerConfigured");
  return html`<span class="cron-trigger-icon" role="img" aria-label=${label} title=${label}
    >${icon("gitBranch")}</span
  >`;
}

/** Auto-disabled is the escalated failure state, not an operator pause: the
 * recorded fact (state.autoDisabled) must stay visible or the job silently
 * drops out of every failure surface the moment the problem became permanent. */
export function renderDisabledNote(job: CronJob) {
  const autoDisabled = job.state?.autoDisabled;
  if (!autoDisabled) {
    return html`<span class="muted cron-table__paused-note">${t("cron.list.paused")}</span>`;
  }
  const label = disabledNoteLabel(autoDisabled);
  const lastError = job.state?.lastError?.trim();
  return html`<span
    class="cron-table__paused-note cron-table__auto-disabled"
    data-test-id=${`cron-row-auto-disabled-${job.id}`}
    title=${lastError ? formatUiExternalText(lastError) : label}
    >${label}</span
  >`;
}

function disabledNoteLabel(
  autoDisabled: NonNullable<NonNullable<CronJob["state"]>["autoDisabled"]>,
) {
  return t(
    autoDisabled.reason === "schedule-errors"
      ? "cron.list.autoDisabledScheduleErrors"
      : "cron.list.autoDisabledRunFailures",
    { count: String(autoDisabled.consecutiveErrors) },
  );
}

export function renderLastRunCell(job: CronJob) {
  const status = resolveCronJobLastRunStatus(job);
  const lastRunAtMs = job.state?.lastRunAtMs;
  const rel =
    typeof lastRunAtMs === "number" && Number.isFinite(lastRunAtMs)
      ? formatRelativeTimestamp(lastRunAtMs)
      : null;
  if (status === "unknown" || !rel) {
    return html`<span class="muted">${t("common.na")}</span>`;
  }
  // Bare glyph + time reads calmer than a chip per row; the status word stays
  // available to hover and assistive tech via the label.
  const glyph =
    status === "ok"
      ? html`<span class="cron-last-glyph cron-last-glyph--ok">${icon("check")}</span>`
      : status === "error"
        ? html`<span class="cron-last-glyph cron-last-glyph--error">${icon("x")}</span>`
        : html`<span class="cron-last-glyph">${icon("cornerDownRight")}</span>`;
  const label = runStatusLabel(status);
  return html`
    <span class="cron-table__last-run" role="img" aria-label=${label} title=${label}>
      ${glyph}
      <span class="cron-table__last-time">${rel}</span>
    </span>
  `;
}
