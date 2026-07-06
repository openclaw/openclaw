// builtin:cron — next runs + last status per job over `cron.list`. Binding value
// shape: `{ jobs: CronJob[] }` where each job carries `state.nextRunAtMs` and
// `state.lastRunStatus` (see ui/src/api/types.ts CronJob / CronJobState).

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { formatDateTimeMs } from "../../format.ts";
import type { DashboardWidget } from "../types.ts";
import { isRecord, toFiniteNumber, widgetProps } from "./types.ts";

const DEFAULT_LIMIT = 8;

export type CronJobModel = {
  id: string;
  name: string;
  enabled: boolean;
  nextRunAtMs: number | null;
  lastStatus: string | null;
};

export type CronModel = {
  jobs: CronJobModel[];
  total: number;
};

function jobStatus(state: Record<string, unknown> | undefined): string | null {
  if (!state) {
    return null;
  }
  const status = state.lastRunStatus ?? state.lastStatus;
  return typeof status === "string" ? status : null;
}

export function mapCron(widget: DashboardWidget, value: unknown): CronModel {
  const raw = isRecord(value) && Array.isArray(value.jobs) ? value.jobs : [];
  const limitProp = toFiniteNumber(widgetProps(widget).limit);
  const limit = limitProp && limitProp > 0 ? Math.trunc(limitProp) : DEFAULT_LIMIT;
  const records = raw.filter(isRecord);
  const jobs = records
    .map((job) => {
      const state = isRecord(job.state) ? job.state : undefined;
      return {
        id: typeof job.id === "string" ? job.id : "",
        name: typeof job.name === "string" && job.name.trim() ? job.name : (job.id as string) || "",
        enabled: job.enabled !== false,
        nextRunAtMs: state ? (toFiniteNumber(state.nextRunAtMs) ?? null) : null,
        lastStatus: jobStatus(state),
      };
    })
    .filter((job) => job.id)
    .slice(0, limit);
  return { jobs, total: records.length };
}

function statusClass(status: string | null): string {
  if (status === "ok") {
    return "dashboard-badge--ok";
  }
  if (status === "error") {
    return "dashboard-badge--error";
  }
  return "dashboard-badge--muted";
}

export function renderCron(widget: DashboardWidget, value: unknown): TemplateResult {
  const model = mapCron(widget, value);
  if (model.jobs.length === 0) {
    return html`<div class="dashboard-widget__placeholder">
      ${t("dashboard.widget.cron.empty")}
    </div>`;
  }
  return html`
    <ul class="dashboard-list dashboard-cron" data-test-id="dashboard-cron">
      ${model.jobs.map(
        (job) => html`
          <li class="dashboard-list__row ${job.enabled ? "" : "dashboard-list__row--disabled"}">
            <span class="dashboard-list__label">${job.name}</span>
            <span class="dashboard-list__meta">
              ${job.nextRunAtMs !== null
                ? t("dashboard.widget.cron.next", { time: formatDateTimeMs(job.nextRunAtMs) })
                : t("dashboard.widget.cron.noNext")}
            </span>
            ${job.lastStatus
              ? html`<span class="dashboard-badge ${statusClass(job.lastStatus)}"
                  >${job.lastStatus}</span
                >`
              : nothing}
          </li>
        `,
      )}
    </ul>
  `;
}
