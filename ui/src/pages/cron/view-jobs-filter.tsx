import { For } from "solid-js";
import type { CronJobsScheduleKindFilter } from "../../api/types.ts";
import type { PickerOption } from "../../components/select-picker.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { syncPopoverExpanded, syncPopoverLabel } from "../../components/web-awesome-popover.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { CronProps } from "./view-types.ts";
registerEnglishCatalog(registerCronEnglish);
const SCHEDULE_KIND_FILTER_LABELS: Record<CronJobsScheduleKindFilter, string> = {
  all: "cron.jobs.all",
  at: "cron.form.at",
  every: "cron.form.every",
  cron: "cron.form.cronOption",
  "on-exit": "cron.form.repeatOnExit",
  stream: "cron.form.repeatStream",
};
function JobsFilter(componentProps: {
  props: CronProps;
  field: keyof Parameters<CronProps["onJobsFiltersChange"]>[0];
  params: {
    label: string;
    value: string;
    options: readonly PickerOption[];
    testId?: string;
  };
}) {
  return (
    <label class="field">
      <span>{componentProps.params.label}</span>
      <select
        class="settings-select"
        data-test-id={componentProps.params.testId}
        prop:value={componentProps.params.value}
        onChange={(event: Event) => {
          if (event.currentTarget instanceof HTMLSelectElement) {
            void componentProps.props.onJobsFiltersChange({
              [componentProps.field]: event.currentTarget.value,
            });
          }
        }}
      >
        {
          <For each={componentProps.params.options} keyed={(option) => option.value}>
            {(option) => (
              <option
                value={option().value}
                selected={option().value === componentProps.params.value}
              >
                {option().label}
              </option>
            )}
          </For>
        }
      </select>
    </label>
  );
}
export function JobsFilterPopover(componentProps: { props: CronProps; active: boolean }) {
  return (
    <>
      <button
        id="cron-jobs-filter-trigger"
        type="button"
        class={["btn btn--sm cron-filter-popover__trigger", { active: componentProps.active }]}
        title={t("cron.list.filters")}
        aria-label={t("cron.list.filters")}
        aria-haspopup="dialog"
        aria-expanded="false"
      >
        <Icon name="listFilter" />
      </button>
      <wa-popover
        ref={syncPopoverLabel}
        class="cron-filter-popover"
        for="cron-jobs-filter-trigger"
        aria-label={t("cron.list.filters")}
        placement="bottom-end"
        without-arrow
        onWa-show={syncPopoverExpanded}
        onWa-hide={syncPopoverExpanded}
      >
        <div class="cron-filter-popover__panel">
          <JobsFilter
            props={componentProps.props}
            field="cronJobsScheduleKindFilter"
            params={{
              label: t("cron.jobs.schedule"),
              value: componentProps.props.jobsScheduleKindFilter,
              testId: "cron-jobs-schedule-filter",
              options: Object.entries(SCHEDULE_KIND_FILTER_LABELS).map(([value, labelKey]) => ({
                value,
                label: t(labelKey),
              })),
            }}
          />
          <JobsFilter
            props={componentProps.props}
            field="cronJobsLastStatusFilter"
            params={{
              label: t("cron.jobs.lastRun"),
              value: componentProps.props.jobsLastStatusFilter,
              testId: "cron-jobs-last-status-filter",
              options: [
                { value: "all", label: t("cron.jobs.all") },
                { value: "ok", label: t("cron.runs.runStatusOk") },
                { value: "error", label: t("cron.runs.runStatusError") },
                { value: "skipped", label: t("cron.runs.runStatusSkipped") },
                { value: "unknown", label: t("cron.runs.runStatusUnknown") },
              ],
            }}
          />
          <JobsFilter
            props={componentProps.props}
            field="cronJobsTriggerFilter"
            params={{
              label: t("cron.jobs.condition"),
              value: componentProps.props.jobsTriggerFilter,
              testId: "cron-jobs-trigger-filter",
              options: [
                { value: "all", label: t("cron.jobs.all") },
                { value: "conditional", label: t("cron.jobs.conditional") },
                { value: "unconditional", label: t("cron.jobs.unconditional") },
              ],
            }}
          />
          <JobsFilter
            props={componentProps.props}
            field="cronJobsSortBy"
            params={{
              label: t("cron.jobs.sort"),
              value: componentProps.props.jobsSortBy,
              options: [
                { value: "nextRunAtMs", label: t("cron.jobs.nextRun") },
                { value: "updatedAtMs", label: t("cron.jobs.recentlyUpdated") },
                { value: "name", label: t("cron.jobs.name") },
              ],
            }}
          />
          <JobsFilter
            props={componentProps.props}
            field="cronJobsSortDir"
            params={{
              label: t("cron.jobs.direction"),
              value: componentProps.props.jobsSortDir,
              options: [
                { value: "asc", label: t("cron.jobs.ascending") },
                { value: "desc", label: t("cron.jobs.descending") },
              ],
            }}
          />
          <button
            class="btn btn--sm"
            data-test-id="cron-jobs-filters-reset"
            disabled={!componentProps.active}
            onClick={() => void componentProps.props.onJobsFiltersReset()}
          >
            {t("cron.jobs.reset")}
          </button>
        </div>
      </wa-popover>
    </>
  );
}
