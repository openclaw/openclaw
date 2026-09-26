import { html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import type { CronJobsScheduleKindFilter } from "../../api/types.ts";
import { icon } from "../../components/icons.ts";
import type { PickerOption } from "../../components/select-picker.ts";
import { syncPopoverLabel } from "../../components/web-awesome-popover.ts";
import { t } from "../../i18n/index.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import type { CronProps } from "./view-types.ts";

registerCronEnglish();

const SCHEDULE_KIND_FILTER_LABELS: Record<CronJobsScheduleKindFilter, string> = {
  all: "cron.jobs.all",
  at: "cron.form.at",
  every: "cron.form.every",
  cron: "cron.form.cronOption",
  "on-exit": "cron.form.repeatOnExit",
  stream: "cron.form.repeatStream",
};

function renderJobsFilter(
  props: CronProps,
  field: keyof Parameters<CronProps["onJobsFiltersChange"]>[0],
  params: {
    label: string;
    value: string;
    options: readonly PickerOption[];
    testId?: string;
  },
) {
  return html`
    <label class="field">
      <span>${params.label}</span>
      <select
        class="settings-select"
        data-test-id=${ifDefined(params.testId)}
        .value=${params.value}
        @change=${(event: Event) => {
          if (event.currentTarget instanceof HTMLSelectElement) {
            return props.onJobsFiltersChange({ [field]: event.currentTarget.value });
          }
        }}
      >
        ${params.options.map(
          // Same first-option fallback as renderCronSelect: mark the bound value.
          ({ value, label }) =>
            html`<option value=${value} ?selected=${value === params.value}>${label}</option>`,
        )}
      </select>
    </label>
  `;
}

export function renderJobsFilterPopover(props: CronProps, active: boolean) {
  return html`
    <button
      id="cron-jobs-filter-trigger"
      type="button"
      class="btn btn--sm cron-filter-popover__trigger ${active ? "active" : ""}"
      title=${t("cron.list.filters")}
      aria-label=${t("cron.list.filters")}
      aria-haspopup="dialog"
      aria-expanded="false"
    >
      ${icon("listFilter")}
    </button>
    <wa-popover
      ${ref(syncPopoverLabel)}
      class="cron-filter-popover"
      for="cron-jobs-filter-trigger"
      aria-label=${t("cron.list.filters")}
      placement="bottom-end"
      without-arrow
      @wa-show=${(event: Event) => {
        if (event.currentTarget instanceof Element) {
          event.currentTarget.previousElementSibling?.setAttribute("aria-expanded", "true");
        }
      }}
      @wa-hide=${(event: Event) => {
        if (event.currentTarget instanceof Element) {
          event.currentTarget.previousElementSibling?.setAttribute("aria-expanded", "false");
        }
      }}
    >
      <div class="cron-filter-popover__panel">
        ${renderJobsFilter(props, "cronJobsScheduleKindFilter", {
          label: t("cron.jobs.schedule"),
          value: props.jobsScheduleKindFilter,
          testId: "cron-jobs-schedule-filter",
          options: Object.entries(SCHEDULE_KIND_FILTER_LABELS).map(([value, labelKey]) => ({
            value,
            label: t(labelKey),
          })),
        })}
        ${renderJobsFilter(props, "cronJobsLastStatusFilter", {
          label: t("cron.jobs.lastRun"),
          value: props.jobsLastStatusFilter,
          testId: "cron-jobs-last-status-filter",
          options: [
            { value: "all", label: t("cron.jobs.all") },
            { value: "ok", label: t("cron.runs.runStatusOk") },
            { value: "error", label: t("cron.runs.runStatusError") },
            { value: "skipped", label: t("cron.runs.runStatusSkipped") },
            { value: "unknown", label: t("cron.runs.runStatusUnknown") },
          ],
        })}
        ${renderJobsFilter(props, "cronJobsTriggerFilter", {
          label: t("cron.jobs.condition"),
          value: props.jobsTriggerFilter,
          testId: "cron-jobs-trigger-filter",
          options: [
            { value: "all", label: t("cron.jobs.all") },
            { value: "conditional", label: t("cron.jobs.conditional") },
            { value: "unconditional", label: t("cron.jobs.unconditional") },
          ],
        })}
        ${renderJobsFilter(props, "cronJobsSortBy", {
          label: t("cron.jobs.sort"),
          value: props.jobsSortBy,
          options: [
            { value: "nextRunAtMs", label: t("cron.jobs.nextRun") },
            { value: "updatedAtMs", label: t("cron.jobs.recentlyUpdated") },
            { value: "name", label: t("cron.jobs.name") },
          ],
        })}
        ${renderJobsFilter(props, "cronJobsSortDir", {
          label: t("cron.jobs.direction"),
          value: props.jobsSortDir,
          options: [
            { value: "asc", label: t("cron.jobs.ascending") },
            { value: "desc", label: t("cron.jobs.descending") },
          ],
        })}
        <button
          class="btn btn--sm"
          data-test-id="cron-jobs-filters-reset"
          ?disabled=${!active}
          @click=${props.onJobsFiltersReset}
        >
          ${t("cron.jobs.reset")}
        </button>
      </div>
    </wa-popover>
  `;
}
