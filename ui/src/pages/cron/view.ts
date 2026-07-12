// Control UI view renders the Automations (cron) screen: a task list pane on
// the left and a detail pane (create form, task editor, or recent activity).
import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { ChannelUiMetaEntry, CronJob, CronRunLogEntry, CronStatus } from "../../api/types.ts";
import type {
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronRunsStatusValue,
  CronJobsSortBy,
  CronSortDir,
} from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { icon } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { resolveCronJobLastRunStatus } from "../../lib/cron-status.ts";
import type {
  CronFieldErrors,
  CronFieldKey,
  CronJobsLastStatusFilter,
  CronJobsScheduleKindFilter,
} from "../../lib/cron/index.ts";
import type { CronFormState } from "../../lib/cron/index.ts";
import { formatRelativeTimestamp, formatMs } from "../../lib/format.ts";
import { formatCronSchedule, formatNextRun } from "../../lib/presenter.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { normalizeStringEntries, uniqueStrings } from "../../lib/string-coerce.ts";

type CronPanelMode = "overview" | "create" | "job";

type CronProps = {
  basePath: string;
  loading: boolean;
  jobsLoadingMore: boolean;
  status: CronStatus | null;
  jobs: CronJob[];
  jobsTotal: number;
  jobsHasMore: boolean;
  jobsQuery: string;
  jobsEnabledFilter: CronJobsEnabledFilter;
  jobsScheduleKindFilter: CronJobsScheduleKindFilter;
  jobsLastStatusFilter: CronJobsLastStatusFilter;
  jobsSortBy: CronJobsSortBy;
  jobsSortDir: CronSortDir;
  error: string | null;
  busy: boolean;
  form: CronFormState;
  fieldErrors: CronFieldErrors;
  canSubmit: boolean;
  editingJobId: string | null;
  createOpen: boolean;
  channels: string[];
  channelLabels?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  runs: CronRunLogEntry[];
  runsTotal: number;
  runsHasMore: boolean;
  runsLoadingMore: boolean;
  runsStatuses: CronRunsStatusValue[];
  runsDeliveryStatuses: CronDeliveryStatus[];
  runsQuery: string;
  runsSortDir: CronSortDir;
  agentSuggestions: string[];
  modelSuggestions: string[];
  thinkingSuggestions: string[];
  timezoneSuggestions: string[];
  deliveryToSuggestions: string[];
  accountSuggestions: string[];
  onFormChange: (patch: Partial<CronFormState>) => void;
  onRefresh: () => void;
  onSubmit: () => void;
  onSelectJob: (job: CronJob) => void;
  onOpenCreate: (patch?: Partial<CronFormState>) => void;
  onClosePanel: () => void;
  onClone: (job: CronJob) => void;
  onToggle: (job: CronJob, enabled: boolean) => void;
  onRun: (job: CronJob, mode?: "force" | "due") => void;
  onRemove: (job: CronJob) => void;
  onLoadMoreJobs: () => void;
  onJobsFiltersChange: (patch: {
    cronJobsQuery?: string;
    cronJobsEnabledFilter?: CronJobsEnabledFilter;
    cronJobsScheduleKindFilter?: CronJobsScheduleKindFilter;
    cronJobsLastStatusFilter?: CronJobsLastStatusFilter;
    cronJobsSortBy?: CronJobsSortBy;
    cronJobsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onJobsFiltersReset: () => void | Promise<void>;
  onLoadMoreRuns: () => void;
  onRunsFiltersChange: (patch: {
    cronRunsStatuses?: CronRunsStatusValue[];
    cronRunsDeliveryStatuses?: CronDeliveryStatus[];
    cronRunsQuery?: string;
    cronRunsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onNavigateToChat?: (sessionKey: string) => void;
};

// ── Suggestions ──
// Starter templates shown under the task list; picking one opens the create
// panel prefilled so the schedule/prompt stay fully editable.

type CronSuggestion = {
  id: string;
  iconName: Parameters<typeof icon>[0];
  titleKey: string;
  scheduleKey: string;
  descriptionKey: string;
  patch: () => Partial<CronFormState>;
};

const SUGGESTION_BASE: Partial<CronFormState> = {
  payloadKind: "agentTurn",
  sessionTarget: "isolated",
  deliveryMode: "announce",
  wakeMode: "now",
  deleteAfterRun: false,
  enabled: true,
  scheduleKind: "cron",
};

export const CRON_SUGGESTIONS: CronSuggestion[] = [
  {
    id: "morning-brief",
    iconName: "sun",
    titleKey: "cron.suggestions.morningBrief.title",
    scheduleKey: "cron.suggestions.morningBrief.schedule",
    descriptionKey: "cron.suggestions.morningBrief.description",
    patch: () => ({
      ...SUGGESTION_BASE,
      name: t("cron.suggestions.morningBrief.title"),
      payloadText: t("cron.suggestions.morningBrief.prompt"),
      cronExpr: "0 8 * * 1-5",
    }),
  },
  {
    id: "weekly-review",
    iconName: "fileText",
    titleKey: "cron.suggestions.weeklyReview.title",
    scheduleKey: "cron.suggestions.weeklyReview.schedule",
    descriptionKey: "cron.suggestions.weeklyReview.description",
    patch: () => ({
      ...SUGGESTION_BASE,
      name: t("cron.suggestions.weeklyReview.title"),
      payloadText: t("cron.suggestions.weeklyReview.prompt"),
      cronExpr: "0 16 * * 5",
    }),
  },
  {
    id: "follow-ups",
    iconName: "listChecks",
    titleKey: "cron.suggestions.followUps.title",
    scheduleKey: "cron.suggestions.followUps.schedule",
    descriptionKey: "cron.suggestions.followUps.description",
    patch: () => ({
      ...SUGGESTION_BASE,
      name: t("cron.suggestions.followUps.title"),
      payloadText: t("cron.suggestions.followUps.prompt"),
      cronExpr: "0 9 * * 1-5",
    }),
  },
];

// ── Shared option helpers ──

function getRunStatusOptions(): Array<{ value: CronRunsStatusValue; label: string }> {
  return [
    { value: "ok", label: t("cron.runs.runStatusOk") },
    { value: "error", label: t("cron.runs.runStatusError") },
    { value: "skipped", label: t("cron.runs.runStatusSkipped") },
  ];
}

function getRunDeliveryOptions(): Array<{ value: CronDeliveryStatus; label: string }> {
  return [
    { value: "delivered", label: t("cron.runs.deliveryDelivered") },
    { value: "not-delivered", label: t("cron.runs.deliveryNotDelivered") },
    { value: "unknown", label: t("cron.runs.deliveryUnknown") },
    { value: "not-requested", label: t("cron.runs.deliveryNotRequested") },
  ];
}

function toggleSelection<T extends string>(selected: T[], value: T, checked: boolean): T[] {
  const set = new Set(selected);
  if (checked) {
    set.add(value);
  } else {
    set.delete(value);
  }
  return Array.from(set);
}

function summarizeSelection(selectedLabels: string[], allLabel: string) {
  if (selectedLabels.length === 0) {
    return allLabel;
  }
  if (selectedLabels.length <= 2) {
    return selectedLabels.join(", ");
  }
  return `${selectedLabels[0]} +${selectedLabels.length - 1}`;
}

function buildChannelOptions(props: CronProps): string[] {
  const options = ["last", ...props.channels.filter(Boolean)];
  const current = props.form.deliveryChannel?.trim();
  if (current && !options.includes(current)) {
    options.push(current);
  }
  const seen = new Set<string>();
  return options.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function resolveChannelLabel(props: CronProps, channel: string): string {
  if (channel === "last") {
    return "last";
  }
  const meta = props.channelMeta?.find((entry) => entry.id === channel);
  if (meta?.label) {
    return meta.label;
  }
  return props.channelLabels?.[channel] ?? channel;
}

function renderFilterDropdown(params: {
  id: string;
  title: string;
  summary: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (value: string, checked: boolean) => void;
  onClear: () => void;
}) {
  return html`
    <div class="field cron-filter-dropdown" data-filter=${params.id}>
      <span>${params.title}</span>
      <details class="cron-filter-dropdown__details">
        <summary class="btn cron-filter-dropdown__trigger">
          <span>${params.summary}</span>
        </summary>
        <div class="cron-filter-dropdown__panel">
          <div class="cron-filter-dropdown__list">
            ${params.options.map(
              (option) => html`
                <label class="cron-filter-dropdown__option">
                  <input
                    type="checkbox"
                    value=${option.value}
                    .checked=${params.selected.includes(option.value)}
                    @change=${(event: Event) => {
                      const target = event.target as HTMLInputElement;
                      params.onToggle(option.value, target.checked);
                    }}
                  />
                  <span>${option.label}</span>
                </label>
              `,
            )}
          </div>
          <div class="row">
            <button class="btn" type="button" @click=${params.onClear}>
              ${t("cron.runs.clear")}
            </button>
          </div>
        </div>
      </details>
    </div>
  `;
}

function renderSuggestionList(id: string, options: string[]) {
  const clean = uniqueStrings(normalizeStringEntries(options));
  if (clean.length === 0) {
    return nothing;
  }
  return html`<datalist id=${id}>
    ${clean.map((value) => html`<option value=${value}></option> `)}
  </datalist>`;
}

// ── Validation summary helpers ──

type BlockingField = {
  key: CronFieldKey;
  label: string;
  message: string;
  inputId: string;
};

function errorIdForField(key: CronFieldKey) {
  return `cron-error-${key}`;
}

function inputIdForField(key: CronFieldKey) {
  if (key === "name") {
    return "cron-name";
  }
  if (key === "scheduleAt") {
    return "cron-schedule-at";
  }
  if (key === "everyAmount") {
    return "cron-every-amount";
  }
  if (key === "cronExpr") {
    return "cron-cron-expr";
  }
  if (key === "staggerAmount") {
    return "cron-stagger-amount";
  }
  if (key === "payloadText") {
    return "cron-payload-text";
  }
  if (key === "payloadModel") {
    return "cron-payload-model";
  }
  if (key === "payloadThinking") {
    return "cron-payload-thinking";
  }
  if (key === "timeoutSeconds") {
    return "cron-timeout-seconds";
  }
  if (key === "failureAlertAfter") {
    return "cron-failure-alert-after";
  }
  if (key === "failureAlertCooldownSeconds") {
    return "cron-failure-alert-cooldown-seconds";
  }
  return "cron-delivery-to";
}

function fieldLabelForKey(
  key: CronFieldKey,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
) {
  if (key === "payloadText") {
    return form.payloadKind === "systemEvent"
      ? t("cron.form.mainTimelineMessage")
      : t("cron.form.assistantTaskPrompt");
  }
  if (key === "deliveryTo") {
    return deliveryMode === "webhook" ? t("cron.form.webhookUrl") : t("cron.form.to");
  }
  const labels: Record<CronFieldKey, string> = {
    name: t("cron.form.fieldName"),
    scheduleAt: t("cron.form.runAt"),
    everyAmount: t("cron.form.every"),
    cronExpr: t("cron.form.expression"),
    staggerAmount: t("cron.form.staggerWindow"),
    payloadText: t("cron.form.assistantTaskPrompt"),
    payloadModel: t("cron.form.model"),
    payloadThinking: t("cron.form.thinking"),
    timeoutSeconds: t("cron.form.timeoutSeconds"),
    deliveryTo: t("cron.form.to"),
    failureAlertAfter: t("cron.form.failureAlertAfter"),
    failureAlertCooldownSeconds: t("cron.form.failureAlertCooldown"),
  };
  return labels[key];
}

function collectBlockingFields(
  errors: CronFieldErrors,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
): BlockingField[] {
  const orderedKeys: CronFieldKey[] = [
    "name",
    "scheduleAt",
    "everyAmount",
    "cronExpr",
    "staggerAmount",
    "payloadText",
    "payloadModel",
    "payloadThinking",
    "timeoutSeconds",
    "deliveryTo",
    "failureAlertAfter",
    "failureAlertCooldownSeconds",
  ];
  const fields: BlockingField[] = [];
  for (const key of orderedKeys) {
    const message = errors[key];
    if (!message) {
      continue;
    }
    fields.push({
      key,
      label: fieldLabelForKey(key, form, deliveryMode),
      message,
      inputId: inputIdForField(key),
    });
  }
  return fields;
}

function focusFormField(id: string) {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLElement)) {
    return;
  }
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  el.focus();
}

function renderFieldError(message?: string, id?: string) {
  if (!message) {
    return nothing;
  }
  return html`<div id=${ifDefined(id)} class="cron-help cron-error">${t(message)}</div>`;
}

// ── Row primitives (label left, control right — matches detail pane style) ──

function renderRow(params: {
  label: string;
  control: unknown;
  required?: boolean;
  help?: string;
  error?: string;
  errorId?: string;
}) {
  return html`
    <label class="cron-row">
      <span class="cron-row__label">
        ${params.label}
        ${params.required
          ? html`
              <span class="cron-required-marker" aria-hidden="true">*</span>
              <span class="cron-required-sr">${t("cron.form.requiredSr")}</span>
            `
          : nothing}
      </span>
      <div class="cron-row__control">
        ${params.control}
        ${params.help ? html`<div class="cron-help">${params.help}</div>` : nothing}
        ${renderFieldError(params.error, params.errorId)}
      </div>
    </label>
  `;
}

function renderCheckboxRow(params: {
  label: string;
  checked: boolean;
  help?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return html`
    <label class="cron-row cron-row--checkbox">
      <span class="cron-row__label">${params.label}</span>
      <div class="cron-row__control">
        <input
          type="checkbox"
          .checked=${params.checked}
          ?disabled=${params.disabled}
          @change=${(e: Event) => params.onChange((e.target as HTMLInputElement).checked)}
        />
        ${params.help ? html`<div class="cron-help">${params.help}</div>` : nothing}
      </div>
    </label>
  `;
}

// ── Main render ──

export function renderCron(props: CronProps) {
  const mode: CronPanelMode = props.editingJobId ? "job" : props.createOpen ? "create" : "overview";
  return html`
    <section class="cron-layout" data-panel-mode=${mode}>
      ${renderListPane(props)} ${renderDetailPane(props, mode)}
    </section>
    ${renderSuggestionList("cron-agent-suggestions", props.agentSuggestions)}
    ${renderSuggestionList("cron-model-suggestions", props.modelSuggestions)}
    ${renderSuggestionList("cron-thinking-suggestions", props.thinkingSuggestions)}
    ${renderSuggestionList("cron-tz-suggestions", props.timezoneSuggestions)}
    ${renderSuggestionList("cron-delivery-to-suggestions", props.deliveryToSuggestions)}
    ${renderSuggestionList("cron-delivery-account-suggestions", props.accountSuggestions)}
  `;
}

// ── List pane ──

const ENABLED_TABS: Array<{ value: CronJobsEnabledFilter; labelKey: string }> = [
  { value: "all", labelKey: "cron.tabs.all" },
  { value: "enabled", labelKey: "cron.tabs.active" },
  { value: "disabled", labelKey: "cron.tabs.paused" },
];

function renderListPane(props: CronProps) {
  const hasAdvancedJobsFilters =
    props.jobsScheduleKindFilter !== "all" ||
    props.jobsLastStatusFilter !== "all" ||
    props.jobsSortBy !== "nextRunAtMs" ||
    props.jobsSortDir !== "asc";
  const hasAnyJobsFilters =
    hasAdvancedJobsFilters ||
    props.jobsQuery.trim().length > 0 ||
    props.jobsEnabledFilter !== "all";
  const showSuggestions = !hasAnyJobsFilters;
  return html`
    <div class="cron-list-pane card">
      <div class="cron-list-toolbar">
        <div class="cron-tabs" role="tablist">
          ${ENABLED_TABS.map(
            (tab) => html`
              <button
                type="button"
                role="tab"
                class="cron-tab ${props.jobsEnabledFilter === tab.value ? "cron-tab--active" : ""}"
                aria-selected=${props.jobsEnabledFilter === tab.value ? "true" : "false"}
                data-test-id=${`cron-tab-${tab.value}`}
                @click=${() => props.onJobsFiltersChange({ cronJobsEnabledFilter: tab.value })}
              >
                ${t(tab.labelKey)}
              </button>
            `,
          )}
        </div>
        <button
          type="button"
          class="btn primary btn--sm cron-new-task"
          data-test-id="cron-new-task"
          @click=${() => props.onOpenCreate()}
        >
          ${icon("plus")} ${t("cron.list.newTask")}
        </button>
      </div>
      <div class="cron-list-search">
        <div class="cron-search-box">
          <span class="cron-search-box__icon" aria-hidden="true">${icon("search")}</span>
          <input
            type="search"
            .value=${props.jobsQuery}
            placeholder=${t("cron.list.searchPlaceholder")}
            @input=${(e: Event) =>
              props.onJobsFiltersChange({
                cronJobsQuery: (e.target as HTMLInputElement).value,
              })}
          />
        </div>
        ${renderJobsFilterPopover(props, hasAdvancedJobsFilters)}
      </div>
      ${props.error ? html`<div class="cron-error-banner">${props.error}</div>` : nothing}
      <div class="cron-list-scroll">
        ${props.jobs.length === 0
          ? html`
              <div class="cron-empty-state">
                <div class="cron-empty-state__title">
                  ${hasAnyJobsFilters ? t("cron.list.noMatching") : t("cron.list.emptyTitle")}
                </div>
                ${hasAnyJobsFilters
                  ? nothing
                  : html`<div class="cron-empty-state__copy">${t("cron.list.emptyHint")}</div>`}
              </div>
            `
          : html`
              <div class="cron-task-list" role="list">
                ${repeat(
                  props.jobs,
                  (job) => job.id,
                  (job) => renderTaskRow(job, props),
                )}
              </div>
            `}
        ${props.jobsHasMore
          ? html`
              <button
                class="btn btn--sm cron-load-more"
                ?disabled=${props.loading || props.jobsLoadingMore}
                @click=${props.onLoadMoreJobs}
              >
                ${props.jobsLoadingMore ? t("cron.list.loading") : t("cron.list.loadMore")}
              </button>
            `
          : nothing}
        ${showSuggestions ? renderSuggestions(props) : nothing}
      </div>
      ${renderListFooter(props)}
    </div>
  `;
}

function renderJobsFilterPopover(props: CronProps, active: boolean) {
  return html`
    <details class="cron-filter-popover">
      <summary
        class="btn btn--sm cron-filter-popover__trigger ${active ? "active" : ""}"
        title=${t("cron.list.filters")}
        aria-label=${t("cron.list.filters")}
      >
        ${icon("listFilter")}
      </summary>
      <div class="cron-filter-popover__panel">
        <label class="field">
          <span>${t("cron.jobs.schedule")}</span>
          <select
            data-test-id="cron-jobs-schedule-filter"
            .value=${props.jobsScheduleKindFilter}
            @change=${(e: Event) =>
              props.onJobsFiltersChange({
                cronJobsScheduleKindFilter: (e.target as HTMLSelectElement)
                  .value as CronJobsScheduleKindFilter,
              })}
          >
            <option value="all">${t("cron.jobs.all")}</option>
            <option value="at">${t("cron.form.at")}</option>
            <option value="every">${t("cron.form.every")}</option>
            <option value="cron">${t("cron.form.cronOption")}</option>
          </select>
        </label>
        <label class="field">
          <span>${t("cron.jobs.lastRun")}</span>
          <select
            data-test-id="cron-jobs-last-status-filter"
            .value=${props.jobsLastStatusFilter}
            @change=${(e: Event) =>
              props.onJobsFiltersChange({
                cronJobsLastStatusFilter: (e.target as HTMLSelectElement)
                  .value as CronJobsLastStatusFilter,
              })}
          >
            <option value="all">${t("cron.jobs.all")}</option>
            <option value="ok">${t("cron.runs.runStatusOk")}</option>
            <option value="error">${t("cron.runs.runStatusError")}</option>
            <option value="skipped">${t("cron.runs.runStatusSkipped")}</option>
            <option value="unknown">${t("cron.runs.runStatusUnknown")}</option>
          </select>
        </label>
        <label class="field">
          <span>${t("cron.jobs.sort")}</span>
          <select
            .value=${props.jobsSortBy}
            @change=${(e: Event) =>
              props.onJobsFiltersChange({
                cronJobsSortBy: (e.target as HTMLSelectElement).value as CronJobsSortBy,
              })}
          >
            <option value="nextRunAtMs">${t("cron.jobs.nextRun")}</option>
            <option value="updatedAtMs">${t("cron.jobs.recentlyUpdated")}</option>
            <option value="name">${t("cron.jobs.name")}</option>
          </select>
        </label>
        <label class="field">
          <span>${t("cron.jobs.direction")}</span>
          <select
            .value=${props.jobsSortDir}
            @change=${(e: Event) =>
              props.onJobsFiltersChange({
                cronJobsSortDir: (e.target as HTMLSelectElement).value as CronSortDir,
              })}
          >
            <option value="asc">${t("cron.jobs.ascending")}</option>
            <option value="desc">${t("cron.jobs.descending")}</option>
          </select>
        </label>
        <button
          class="btn btn--sm"
          data-test-id="cron-jobs-filters-reset"
          ?disabled=${!active}
          @click=${props.onJobsFiltersReset}
        >
          ${t("cron.jobs.reset")}
        </button>
      </div>
    </details>
  `;
}

function renderTaskRow(job: CronJob, props: CronProps) {
  const selected = props.editingJobId === job.id;
  const lastStatus = resolveCronJobLastRunStatus(job);
  const nextRunAtMs = job.state?.nextRunAtMs;
  const meta = [formatCronSchedule(job)];
  if (typeof nextRunAtMs === "number" && Number.isFinite(nextRunAtMs)) {
    meta.push(`${t("cron.jobState.next")} ${formatRelativeTimestamp(nextRunAtMs)}`);
  }
  return html`
    <button
      type="button"
      role="listitem"
      class="cron-task ${selected ? "cron-task--selected" : ""} ${job.enabled
        ? ""
        : "cron-task--paused"}"
      @click=${() => props.onSelectJob(job)}
    >
      <span class="cron-task__icon" aria-hidden="true">
        ${icon(job.enabled ? "play" : "pause")}
      </span>
      <span class="cron-task__body">
        <span class="cron-task__name">
          <span class="cron-task__name-text">${job.name}</span>
          ${job.enabled
            ? nothing
            : html`<span class="chip cron-task__chip">${t("cron.list.paused")}</span>`}
        </span>
        <span class="cron-task__meta">${meta.join(" · ")}</span>
      </span>
      ${lastStatus === "error"
        ? html`<span
            class="cron-task__status cron-task__status--error"
            title=${t("cron.runs.runStatusError")}
          ></span>`
        : nothing}
    </button>
  `;
}

function renderSuggestions(props: CronProps) {
  return html`
    <div class="cron-suggestions">
      <div class="cron-suggestions__title">${t("cron.suggestions.title")}</div>
      ${CRON_SUGGESTIONS.map(
        (suggestion) => html`
          <button
            type="button"
            class="cron-suggestion"
            data-suggestion=${suggestion.id}
            @click=${() => props.onOpenCreate(suggestion.patch())}
          >
            <span class="cron-suggestion__icon" aria-hidden="true">
              ${icon(suggestion.iconName)}
            </span>
            <span class="cron-suggestion__body">
              <span class="cron-suggestion__title-line">
                <span class="cron-suggestion__name">${t(suggestion.titleKey)}</span>
                <span class="cron-suggestion__schedule">${t(suggestion.scheduleKey)}</span>
              </span>
              <span class="cron-suggestion__desc">${t(suggestion.descriptionKey)}</span>
            </span>
          </button>
        `,
      )}
    </div>
  `;
}

function renderListFooter(props: CronProps) {
  const schedulerEnabled = props.status?.enabled ?? null;
  return html`
    <div class="cron-list-footer">
      <span class="cron-list-footer__status">
        ${schedulerEnabled === false
          ? html`<span class="chip chip-danger">${t("cron.list.schedulerOff")}</span>`
          : nothing}
        <span class="muted">
          ${t("cron.list.shownOf", {
            shown: String(props.jobs.length),
            total: String(Math.max(props.jobsTotal, props.jobs.length)),
          })}
        </span>
      </span>
      <button
        type="button"
        class="btn btn--sm btn--ghost cron-refresh ${props.loading ? "cron-refresh--loading" : ""}"
        ?disabled=${props.loading}
        title=${props.loading ? t("cron.list.refreshing") : t("cron.list.refresh")}
        aria-label=${t("cron.list.refresh")}
        @click=${props.onRefresh}
      >
        ${icon("refresh")}
      </button>
    </div>
  `;
}

// ── Detail pane ──

function renderDetailPane(props: CronProps, mode: CronPanelMode) {
  return html`
    <div class="cron-detail-pane card">
      ${mode === "overview" ? renderOverview(props) : renderEditor(props, mode)}
    </div>
  `;
}

function renderOverview(props: CronProps) {
  return html`
    <div class="cron-detail-header">
      <div class="cron-detail-header__copy">
        <div class="cron-detail-title">${t("cron.detail.overviewTitle")}</div>
        <div class="cron-detail-sub">${t("cron.detail.overviewSubtitle")}</div>
      </div>
    </div>
    <div class="cron-overview-stats">
      <div class="cron-overview-stat">
        <span class="cron-overview-stat__label">${t("cron.stats.scheduler")}</span>
        <span class=${`chip ${props.status?.enabled ? "chip-ok" : "chip-danger"}`}>
          ${props.status
            ? props.status.enabled
              ? t("common.enabled")
              : t("common.disabled")
            : t("common.na")}
        </span>
      </div>
      <div class="cron-overview-stat">
        <span class="cron-overview-stat__label">${t("cron.stats.tasks")}</span>
        <span class="cron-overview-stat__value">${props.status?.jobs ?? t("common.na")}</span>
      </div>
      <div class="cron-overview-stat">
        <span class="cron-overview-stat__label">${t("cron.stats.nextWake")}</span>
        <span class="cron-overview-stat__value">
          ${formatNextRun(props.status?.nextWakeAtMs ?? null)}
        </span>
      </div>
    </div>
    <div class="cron-detail-scroll">${renderRunsSection(props)}</div>
  `;
}

function renderEditor(props: CronProps, mode: CronPanelMode) {
  const selectedJob =
    mode === "job" ? props.jobs.find((job) => job.id === props.editingJobId) : undefined;
  const payloadLocked = props.form.payloadLocked;
  const isAgentTurn = !payloadLocked && props.form.payloadKind === "agentTurn";
  const supportsAnnounce =
    props.form.sessionTarget !== "main" &&
    (props.form.payloadKind === "agentTurn" || payloadLocked);
  const selectedDeliveryMode =
    props.form.deliveryMode === "announce" && !supportsAnnounce ? "none" : props.form.deliveryMode;
  const blockingFields = collectBlockingFields(props.fieldErrors, props.form, selectedDeliveryMode);
  const blockedByValidation = !props.busy && blockingFields.length > 0;
  const submitDisabledReason =
    blockedByValidation && !props.canSubmit
      ? blockingFields.length === 1
        ? t("cron.form.fixFields", { count: String(blockingFields.length) })
        : t("cron.form.fixFieldsPlural", { count: String(blockingFields.length) })
      : "";
  const promptLabel = payloadLocked
    ? t("cron.form.command")
    : props.form.payloadKind === "systemEvent"
      ? t("cron.form.mainTimelineMessage")
      : t("cron.form.assistantTaskPrompt");
  return html`
    ${renderEditorHeader(props, mode, selectedJob)}
    <div class="cron-detail-scroll">
      <div class="cron-editor">
        <label class="cron-prompt">
          <span class="cron-prompt__label">
            ${promptLabel}
            <span class="cron-required-marker" aria-hidden="true">*</span>
            <span class="cron-required-sr">${t("cron.form.requiredSr")}</span>
          </span>
          <textarea
            id="cron-payload-text"
            rows="4"
            .value=${props.form.payloadText}
            ?readonly=${payloadLocked}
            placeholder=${t("cron.form.promptPlaceholder")}
            aria-invalid=${props.fieldErrors.payloadText ? "true" : "false"}
            aria-describedby=${ifDefined(
              props.fieldErrors.payloadText ? errorIdForField("payloadText") : undefined,
            )}
            @input=${(e: Event) =>
              props.onFormChange({ payloadText: (e.target as HTMLTextAreaElement).value })}
          ></textarea>
          ${renderFieldError(props.fieldErrors.payloadText, errorIdForField("payloadText"))}
        </label>

        <section class="cron-row-group">
          <div class="cron-row-group__title">${t("cron.detail.detailsSection")}</div>
          <div class="cron-rows">
            ${renderDetailsRows(props, {
              payloadLocked,
              isAgentTurn,
              supportsAnnounce,
              selectedDeliveryMode,
            })}
          </div>
        </section>

        <section class="cron-row-group">
          <div class="cron-row-group__title">${t("cron.detail.frequencySection")}</div>
          <div class="cron-rows">${renderFrequencyRows(props)}</div>
        </section>

        ${renderAdvanced(props, {
          mode,
          isAgentTurn,
          selectedDeliveryMode,
        })}
        ${blockedByValidation
          ? html`
              <div class="cron-form-status" role="status" aria-live="polite">
                <div class="cron-form-status__title">${t("cron.form.cantAddYet")}</div>
                <div class="cron-help">${t("cron.form.fillRequired")}</div>
                <ul class="cron-form-status__list">
                  ${blockingFields.map(
                    (field) => html`
                      <li>
                        <button
                          type="button"
                          class="cron-form-status__link"
                          @click=${() => focusFormField(field.inputId)}
                        >
                          ${field.label}: ${t(field.message)}
                        </button>
                      </li>
                    `,
                  )}
                </ul>
              </div>
            `
          : nothing}
        <div class="cron-editor-actions">
          <button
            class="btn primary"
            data-test-id="cron-submit"
            ?disabled=${props.busy || !props.canSubmit}
            @click=${props.onSubmit}
          >
            ${props.busy
              ? t("cron.form.saving")
              : mode === "job"
                ? t("cron.form.saveChanges")
                : t("cron.form.createTask")}
          </button>
          <button class="btn" ?disabled=${props.busy} @click=${props.onClosePanel}>
            ${t("cron.form.cancel")}
          </button>
          ${submitDisabledReason
            ? html`
                <div class="cron-submit-reason" aria-live="polite">${submitDisabledReason}</div>
              `
            : nothing}
        </div>
      </div>
      ${mode === "job" && selectedJob
        ? html`
            <section class="cron-history">
              <div class="cron-row-group__title">${t("cron.detail.historyTitle")}</div>
              ${renderRunsSection(props)}
            </section>
          `
        : nothing}
    </div>
  `;
}

function renderEditorHeader(props: CronProps, mode: CronPanelMode, selectedJob?: CronJob) {
  const title = mode === "job" ? (selectedJob?.name ?? props.form.name) : t("cron.detail.newTitle");
  const subtitle =
    mode === "job" && selectedJob ? formatCronSchedule(selectedJob) : t("cron.detail.newSubtitle");
  return html`
    <div class="cron-detail-header">
      <div class="cron-detail-header__copy">
        <div class="cron-detail-title">
          ${title}
          ${mode === "job" && selectedJob && !selectedJob.enabled
            ? html`<span class="chip">${t("cron.detail.paused")}</span>`
            : nothing}
        </div>
        <div class="cron-detail-sub">${subtitle}</div>
      </div>
      <div class="cron-detail-actions">
        ${mode === "job" && selectedJob
          ? html`
              <openclaw-tooltip .content=${t("cron.actions.runNow")}>
                <button
                  type="button"
                  class="btn btn--sm"
                  data-test-id="cron-run-now"
                  ?disabled=${props.busy}
                  @click=${() => props.onRun(selectedJob, "force")}
                >
                  ${icon("play")}
                </button>
              </openclaw-tooltip>
              <openclaw-tooltip
                .content=${selectedJob.enabled ? t("cron.actions.pause") : t("cron.actions.resume")}
              >
                <button
                  type="button"
                  class="btn btn--sm"
                  data-test-id="cron-toggle-enabled"
                  ?disabled=${props.busy}
                  @click=${() => props.onToggle(selectedJob, !selectedJob.enabled)}
                >
                  ${icon(selectedJob.enabled ? "pause" : "play")}
                  ${selectedJob.enabled ? t("cron.actions.pause") : t("cron.actions.resume")}
                </button>
              </openclaw-tooltip>
              <details class="cron-job-menu">
                <summary
                  class="btn btn--sm cron-job-menu__trigger"
                  role="button"
                  aria-haspopup="menu"
                  aria-label=${t("cron.actions.more")}
                  title=${t("cron.actions.more")}
                >
                  ${icon("moreHorizontal")}
                </summary>
                <div class="cron-job-menu__panel" role="menu">
                  ${renderMenuItem(props, t("cron.actions.runIfDue"), () =>
                    props.onRun(selectedJob, "due"),
                  )}
                  ${renderMenuItem(props, t("cron.actions.clone"), () =>
                    props.onClone(selectedJob),
                  )}
                  ${renderMenuItem(
                    props,
                    t("cron.actions.remove"),
                    () => props.onRemove(selectedJob),
                    { danger: true },
                  )}
                </div>
              </details>
            `
          : nothing}
        <openclaw-tooltip .content=${t("common.dismiss")}>
          <button
            type="button"
            class="btn btn--sm cron-detail-close"
            data-test-id="cron-form-close"
            aria-label=${t("common.dismiss")}
            @click=${props.onClosePanel}
          >
            ${icon("x")}
          </button>
        </openclaw-tooltip>
      </div>
    </div>
  `;
}

function renderMenuItem(
  props: CronProps,
  label: string,
  action: () => void,
  options?: { danger?: boolean },
) {
  return html`
    <button
      class=${options?.danger ? "cron-job-menu__item danger" : "cron-job-menu__item"}
      role="menuitem"
      ?disabled=${props.busy}
      @click=${(event: Event) => {
        // Close the details-based menu before acting so it does not linger open.
        (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
        action();
      }}
    >
      ${label}
    </button>
  `;
}

function renderDetailsRows(
  props: CronProps,
  ctx: {
    payloadLocked: boolean;
    isAgentTurn: boolean;
    supportsAnnounce: boolean;
    selectedDeliveryMode: CronFormState["deliveryMode"];
  },
) {
  const channelOptions = buildChannelOptions(props);
  const sessionTarget = props.form.sessionTarget;
  const knownSessionTarget = sessionTarget === "main" || sessionTarget === "isolated";
  return html`
    ${renderRow({
      label: t("cron.form.fieldName"),
      required: true,
      error: props.fieldErrors.name,
      errorId: errorIdForField("name"),
      control: html`
        <input
          id="cron-name"
          .value=${props.form.name}
          placeholder=${t("cron.form.namePlaceholder")}
          aria-invalid=${props.fieldErrors.name ? "true" : "false"}
          aria-describedby=${ifDefined(
            props.fieldErrors.name ? errorIdForField("name") : undefined,
          )}
          @input=${(e: Event) => props.onFormChange({ name: (e.target as HTMLInputElement).value })}
        />
      `,
    })}
    ${renderRow({
      label: t("cron.form.agentId"),
      help: t("cron.form.agentHelp"),
      control: html`
        <input
          id="cron-agent-id"
          .value=${props.form.agentId}
          list="cron-agent-suggestions"
          ?disabled=${props.form.clearAgent}
          placeholder=${t("cron.form.agentPlaceholder")}
          @input=${(e: Event) =>
            props.onFormChange({ agentId: (e.target as HTMLInputElement).value })}
        />
      `,
    })}
    ${renderRow({
      label: t("cron.form.runsIn"),
      help: t("cron.form.sessionHelp"),
      control: html`
        <select
          id="cron-session-target"
          .value=${sessionTarget}
          @change=${(e: Event) =>
            props.onFormChange({
              sessionTarget: (e.target as HTMLSelectElement)
                .value as CronFormState["sessionTarget"],
            })}
        >
          <option value="main">${t("cron.form.mainSession")}</option>
          <option value="isolated">${t("cron.form.isolatedSession")}</option>
          ${knownSessionTarget
            ? nothing
            : html`<option value=${sessionTarget}>${sessionTarget}</option>`}
        </select>
      `,
    })}
    ${ctx.payloadLocked
      ? renderRow({
          label: t("cron.form.action"),
          control: html`<input id="cron-payload-kind" .value=${t("cron.form.command")} readonly />`,
        })
      : renderRow({
          label: t("cron.form.action"),
          help:
            props.form.payloadKind === "systemEvent"
              ? t("cron.form.systemEventHelp")
              : t("cron.form.agentTurnHelp"),
          control: html`
            <select
              id="cron-payload-kind"
              .value=${props.form.payloadKind}
              @change=${(e: Event) =>
                props.onFormChange({
                  payloadKind: (e.target as HTMLSelectElement)
                    .value as CronFormState["payloadKind"],
                })}
            >
              <option value="systemEvent">${t("cron.form.systemEvent")}</option>
              <option value="agentTurn">${t("cron.form.agentTurn")}</option>
            </select>
          `,
        })}
    ${ctx.isAgentTurn
      ? html`
          ${renderRow({
            label: t("cron.form.model"),
            help: t("cron.form.modelHelp"),
            error: props.fieldErrors.payloadModel,
            errorId: errorIdForField("payloadModel"),
            control: html`
              <input
                id="cron-payload-model"
                .value=${props.form.payloadModel}
                list="cron-model-suggestions"
                placeholder=${t("cron.form.modelPlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({ payloadModel: (e.target as HTMLInputElement).value })}
              />
            `,
          })}
          ${renderRow({
            label: t("cron.form.thinking"),
            help: t("cron.form.thinkingHelp"),
            error: props.fieldErrors.payloadThinking,
            errorId: errorIdForField("payloadThinking"),
            control: html`
              <input
                id="cron-payload-thinking"
                .value=${props.form.payloadThinking}
                list="cron-thinking-suggestions"
                placeholder=${t("cron.form.thinkingPlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({ payloadThinking: (e.target as HTMLInputElement).value })}
              />
            `,
          })}
        `
      : nothing}
    ${renderRow({
      label: t("cron.form.resultDelivery"),
      help: t("cron.form.deliveryHelp"),
      control: html`
        <select
          id="cron-delivery-mode"
          .value=${ctx.selectedDeliveryMode}
          @change=${(e: Event) =>
            props.onFormChange({
              deliveryMode: (e.target as HTMLSelectElement).value as CronFormState["deliveryMode"],
            })}
        >
          ${ctx.supportsAnnounce
            ? html`<option value="announce">${t("cron.form.announceDefault")}</option>`
            : nothing}
          <option value="webhook">${t("cron.form.webhookPost")}</option>
          <option value="none">${t("cron.form.noneInternal")}</option>
        </select>
      `,
    })}
    ${ctx.selectedDeliveryMode === "announce"
      ? html`
          ${renderRow({
            label: t("cron.form.channel"),
            help: t("cron.form.channelHelp"),
            control: html`
              <select
                id="cron-delivery-channel"
                .value=${props.form.deliveryChannel || "last"}
                @change=${(e: Event) =>
                  props.onFormChange({ deliveryChannel: (e.target as HTMLSelectElement).value })}
              >
                ${channelOptions.map(
                  (channel) =>
                    html`<option value=${channel}>${resolveChannelLabel(props, channel)}</option>`,
                )}
              </select>
            `,
          })}
          ${renderRow({
            label: t("cron.form.to"),
            help: t("cron.form.toHelp"),
            control: html`
              <input
                id="cron-delivery-to"
                .value=${props.form.deliveryTo}
                list="cron-delivery-to-suggestions"
                placeholder=${t("cron.form.toPlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({ deliveryTo: (e.target as HTMLInputElement).value })}
              />
            `,
          })}
        `
      : nothing}
    ${ctx.selectedDeliveryMode === "webhook"
      ? renderRow({
          label: t("cron.form.webhookUrl"),
          required: true,
          help: t("cron.form.webhookHelp"),
          error: props.fieldErrors.deliveryTo,
          errorId: errorIdForField("deliveryTo"),
          control: html`
            <input
              id="cron-delivery-to"
              .value=${props.form.deliveryTo}
              list="cron-delivery-to-suggestions"
              aria-invalid=${props.fieldErrors.deliveryTo ? "true" : "false"}
              aria-describedby=${ifDefined(
                props.fieldErrors.deliveryTo ? errorIdForField("deliveryTo") : undefined,
              )}
              placeholder=${t("cron.form.webhookPlaceholder")}
              @input=${(e: Event) =>
                props.onFormChange({ deliveryTo: (e.target as HTMLInputElement).value })}
            />
          `,
        })
      : nothing}
  `;
}

function renderFrequencyRows(props: CronProps) {
  const form = props.form;
  const isOnExit = form.scheduleKind === "on-exit";
  return html`
    ${renderRow({
      label: t("cron.form.repeat"),
      // on-exit stays selectable only while it is the current value: jobs can
      // convert to an editable schedule, but never back to a watched command.
      help: isOnExit ? t("cron.form.onExitHelp") : undefined,
      control: html`
        <select
          id="cron-schedule-kind"
          .value=${form.scheduleKind}
          @change=${(e: Event) =>
            props.onFormChange({
              scheduleKind: (e.target as HTMLSelectElement).value as CronFormState["scheduleKind"],
            })}
        >
          ${isOnExit
            ? html`<option value="on-exit">${t("cron.form.repeatOnExit")}</option>`
            : nothing}
          <option value="every">${t("cron.form.repeatInterval")}</option>
          <option value="at">${t("cron.form.repeatOnce")}</option>
          <option value="cron">${t("cron.form.repeatCron")}</option>
        </select>
      `,
    })}
    ${form.scheduleKind === "at"
      ? renderRow({
          label: t("cron.form.runAt"),
          required: true,
          error: props.fieldErrors.scheduleAt,
          errorId: errorIdForField("scheduleAt"),
          control: html`
            <input
              id="cron-schedule-at"
              type="datetime-local"
              .value=${form.scheduleAt}
              aria-invalid=${props.fieldErrors.scheduleAt ? "true" : "false"}
              aria-describedby=${ifDefined(
                props.fieldErrors.scheduleAt ? errorIdForField("scheduleAt") : undefined,
              )}
              @input=${(e: Event) =>
                props.onFormChange({ scheduleAt: (e.target as HTMLInputElement).value })}
            />
          `,
        })
      : nothing}
    ${form.scheduleKind === "every"
      ? renderRow({
          label: t("cron.form.every"),
          required: true,
          error: props.fieldErrors.everyAmount,
          errorId: errorIdForField("everyAmount"),
          control: html`
            <div class="cron-inline-controls">
              <input
                id="cron-every-amount"
                .value=${form.everyAmount}
                aria-invalid=${props.fieldErrors.everyAmount ? "true" : "false"}
                aria-describedby=${ifDefined(
                  props.fieldErrors.everyAmount ? errorIdForField("everyAmount") : undefined,
                )}
                placeholder=${t("cron.form.everyAmountPlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({ everyAmount: (e.target as HTMLInputElement).value })}
              />
              <select
                .value=${form.everyUnit}
                aria-label=${t("cron.form.unit")}
                @change=${(e: Event) =>
                  props.onFormChange({
                    everyUnit: (e.target as HTMLSelectElement).value as CronFormState["everyUnit"],
                  })}
              >
                <option value="minutes">${t("cron.form.minutes")}</option>
                <option value="hours">${t("cron.form.hours")}</option>
                <option value="days">${t("cron.form.days")}</option>
              </select>
            </div>
          `,
        })
      : nothing}
    ${form.scheduleKind === "cron"
      ? html`
          ${renderRow({
            label: t("cron.form.expression"),
            required: true,
            error: props.fieldErrors.cronExpr,
            errorId: errorIdForField("cronExpr"),
            control: html`
              <input
                id="cron-cron-expr"
                class="mono"
                .value=${form.cronExpr}
                aria-invalid=${props.fieldErrors.cronExpr ? "true" : "false"}
                aria-describedby=${ifDefined(
                  props.fieldErrors.cronExpr ? errorIdForField("cronExpr") : undefined,
                )}
                placeholder=${t("cron.form.expressionPlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({ cronExpr: (e.target as HTMLInputElement).value })}
              />
            `,
          })}
          ${renderRow({
            label: t("cron.form.timezoneOptional"),
            help: t("cron.form.timezoneHelp"),
            control: html`
              <input
                .value=${form.cronTz}
                list="cron-tz-suggestions"
                placeholder=${t("cron.form.timezonePlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({ cronTz: (e.target as HTMLInputElement).value })}
              />
            `,
          })}
        `
      : nothing}
  `;
}

function renderAdvanced(
  props: CronProps,
  ctx: {
    mode: CronPanelMode;
    isAgentTurn: boolean;
    selectedDeliveryMode: CronFormState["deliveryMode"];
  },
) {
  const isCronSchedule = props.form.scheduleKind === "cron";
  const channelOptions = buildChannelOptions(props);
  return html`
    <details class="cron-advanced">
      <summary class="cron-advanced__summary">${t("cron.form.advanced")}</summary>
      <div class="cron-help">${t("cron.form.advancedHelp")}</div>
      <div class="cron-rows">
        ${renderRow({
          label: t("cron.form.description"),
          control: html`
            <input
              .value=${props.form.description}
              placeholder=${t("cron.form.descriptionPlaceholder")}
              @input=${(e: Event) =>
                props.onFormChange({ description: (e.target as HTMLInputElement).value })}
            />
          `,
        })}
        ${ctx.mode === "create"
          ? renderCheckboxRow({
              label: t("cron.form.startEnabled"),
              checked: props.form.enabled,
              onChange: (checked) => props.onFormChange({ enabled: checked }),
            })
          : nothing}
        ${renderRow({
          label: t("cron.form.wakeMode"),
          help: t("cron.form.wakeModeHelp"),
          control: html`
            <select
              id="cron-wake-mode"
              .value=${props.form.wakeMode}
              @change=${(e: Event) =>
                props.onFormChange({
                  wakeMode: (e.target as HTMLSelectElement).value as CronFormState["wakeMode"],
                })}
            >
              <option value="now">${t("cron.form.now")}</option>
              <option value="next-heartbeat">${t("cron.form.nextHeartbeat")}</option>
            </select>
          `,
        })}
        ${ctx.isAgentTurn
          ? renderRow({
              label: t("cron.form.timeoutSeconds"),
              help: t("cron.form.timeoutHelp"),
              error: props.fieldErrors.timeoutSeconds,
              errorId: errorIdForField("timeoutSeconds"),
              control: html`
                <input
                  id="cron-timeout-seconds"
                  .value=${props.form.timeoutSeconds}
                  placeholder=${t("cron.form.timeoutPlaceholder")}
                  aria-invalid=${props.fieldErrors.timeoutSeconds ? "true" : "false"}
                  aria-describedby=${ifDefined(
                    props.fieldErrors.timeoutSeconds
                      ? errorIdForField("timeoutSeconds")
                      : undefined,
                  )}
                  @input=${(e: Event) =>
                    props.onFormChange({ timeoutSeconds: (e.target as HTMLInputElement).value })}
                />
              `,
            })
          : nothing}
        ${renderCheckboxRow({
          label: t("cron.form.deleteAfterRun"),
          checked: props.form.deleteAfterRun,
          help: t("cron.form.deleteAfterRunHelp"),
          onChange: (checked) => props.onFormChange({ deleteAfterRun: checked }),
        })}
        ${renderCheckboxRow({
          label: t("cron.form.clearAgentOverride"),
          checked: props.form.clearAgent,
          help: t("cron.form.clearAgentHelp"),
          onChange: (checked) => props.onFormChange({ clearAgent: checked }),
        })}
        ${renderRow({
          label: t("cron.form.sessionKey"),
          help: t("cron.form.sessionKeyHelp"),
          control: html`
            <input
              id="cron-session-key"
              .value=${props.form.sessionKey}
              placeholder="agent:main:main"
              @input=${(e: Event) =>
                props.onFormChange({ sessionKey: (e.target as HTMLInputElement).value })}
            />
          `,
        })}
        ${isCronSchedule
          ? html`
              ${renderCheckboxRow({
                label: t("cron.form.exactTiming"),
                checked: props.form.scheduleExact,
                help: t("cron.form.exactTimingHelp"),
                onChange: (checked) => props.onFormChange({ scheduleExact: checked }),
              })}
              ${renderRow({
                label: t("cron.form.staggerWindow"),
                error: props.fieldErrors.staggerAmount,
                errorId: errorIdForField("staggerAmount"),
                control: html`
                  <div class="cron-inline-controls">
                    <input
                      id="cron-stagger-amount"
                      .value=${props.form.staggerAmount}
                      ?disabled=${props.form.scheduleExact}
                      aria-invalid=${props.fieldErrors.staggerAmount ? "true" : "false"}
                      aria-describedby=${ifDefined(
                        props.fieldErrors.staggerAmount
                          ? errorIdForField("staggerAmount")
                          : undefined,
                      )}
                      placeholder=${t("cron.form.staggerPlaceholder")}
                      @input=${(e: Event) =>
                        props.onFormChange({ staggerAmount: (e.target as HTMLInputElement).value })}
                    />
                    <select
                      .value=${props.form.staggerUnit}
                      ?disabled=${props.form.scheduleExact}
                      aria-label=${t("cron.form.staggerUnit")}
                      @change=${(e: Event) =>
                        props.onFormChange({
                          staggerUnit: (e.target as HTMLSelectElement)
                            .value as CronFormState["staggerUnit"],
                        })}
                    >
                      <option value="seconds">${t("cron.form.seconds")}</option>
                      <option value="minutes">${t("cron.form.minutes")}</option>
                    </select>
                  </div>
                `,
              })}
            `
          : nothing}
        ${ctx.isAgentTurn
          ? html`
              ${renderRow({
                label: t("cron.form.accountId"),
                help: t("cron.form.accountIdHelp"),
                control: html`
                  <input
                    id="cron-delivery-account-id"
                    .value=${props.form.deliveryAccountId}
                    list="cron-delivery-account-suggestions"
                    ?disabled=${ctx.selectedDeliveryMode !== "announce"}
                    placeholder="default"
                    @input=${(e: Event) =>
                      props.onFormChange({
                        deliveryAccountId: (e.target as HTMLInputElement).value,
                      })}
                  />
                `,
              })}
              ${renderCheckboxRow({
                label: t("cron.form.lightContext"),
                checked: props.form.payloadLightContext,
                help: t("cron.form.lightContextHelp"),
                onChange: (checked) => props.onFormChange({ payloadLightContext: checked }),
              })}
              ${renderFailureAlertRows(props, channelOptions)}
            `
          : nothing}
        ${ctx.selectedDeliveryMode !== "none"
          ? renderCheckboxRow({
              label: t("cron.form.bestEffortDelivery"),
              checked: props.form.deliveryBestEffort,
              help: t("cron.form.bestEffortHelp"),
              onChange: (checked) => props.onFormChange({ deliveryBestEffort: checked }),
            })
          : nothing}
      </div>
    </details>
  `;
}

function renderFailureAlertRows(props: CronProps, channelOptions: string[]) {
  return html`
    ${renderRow({
      label: t("cron.form.failureAlerts"),
      help: t("cron.form.failureAlertsHelp"),
      control: html`
        <select
          .value=${props.form.failureAlertMode}
          @change=${(e: Event) =>
            props.onFormChange({
              failureAlertMode: (e.target as HTMLSelectElement)
                .value as CronFormState["failureAlertMode"],
            })}
        >
          <option value="inherit">${t("cron.form.failureAlertInherit")}</option>
          <option value="disabled">${t("cron.form.failureAlertDisabled")}</option>
          <option value="custom">${t("cron.form.failureAlertCustom")}</option>
        </select>
      `,
    })}
    ${props.form.failureAlertMode === "custom"
      ? html`
          ${renderRow({
            label: t("cron.form.failureAlertAfter"),
            help: t("cron.form.failureAlertAfterHelp"),
            error: props.fieldErrors.failureAlertAfter,
            errorId: errorIdForField("failureAlertAfter"),
            control: html`
              <input
                id="cron-failure-alert-after"
                .value=${props.form.failureAlertAfter}
                aria-invalid=${props.fieldErrors.failureAlertAfter ? "true" : "false"}
                aria-describedby=${ifDefined(
                  props.fieldErrors.failureAlertAfter
                    ? errorIdForField("failureAlertAfter")
                    : undefined,
                )}
                placeholder="2"
                @input=${(e: Event) =>
                  props.onFormChange({ failureAlertAfter: (e.target as HTMLInputElement).value })}
              />
            `,
          })}
          ${renderRow({
            label: t("cron.form.failureAlertCooldown"),
            help: t("cron.form.failureAlertCooldownHelp"),
            error: props.fieldErrors.failureAlertCooldownSeconds,
            errorId: errorIdForField("failureAlertCooldownSeconds"),
            control: html`
              <input
                id="cron-failure-alert-cooldown-seconds"
                .value=${props.form.failureAlertCooldownSeconds}
                aria-invalid=${props.fieldErrors.failureAlertCooldownSeconds ? "true" : "false"}
                aria-describedby=${ifDefined(
                  props.fieldErrors.failureAlertCooldownSeconds
                    ? errorIdForField("failureAlertCooldownSeconds")
                    : undefined,
                )}
                placeholder="3600"
                @input=${(e: Event) =>
                  props.onFormChange({
                    failureAlertCooldownSeconds: (e.target as HTMLInputElement).value,
                  })}
              />
            `,
          })}
          ${renderRow({
            label: t("cron.form.failureAlertChannel"),
            control: html`
              <select
                .value=${props.form.failureAlertChannel || "last"}
                @change=${(e: Event) =>
                  props.onFormChange({
                    failureAlertChannel: (e.target as HTMLSelectElement).value,
                  })}
              >
                ${channelOptions.map(
                  (channel) =>
                    html`<option value=${channel}>${resolveChannelLabel(props, channel)}</option>`,
                )}
              </select>
            `,
          })}
          ${renderRow({
            label: t("cron.form.failureAlertTo"),
            help: t("cron.form.failureAlertToHelp"),
            control: html`
              <input
                .value=${props.form.failureAlertTo}
                list="cron-delivery-to-suggestions"
                placeholder=${t("cron.form.failureAlertToPlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({ failureAlertTo: (e.target as HTMLInputElement).value })}
              />
            `,
          })}
          ${renderRow({
            label: t("cron.form.failureAlertMode"),
            control: html`
              <select
                .value=${props.form.failureAlertDeliveryMode || "announce"}
                @change=${(e: Event) =>
                  props.onFormChange({
                    failureAlertDeliveryMode: (e.target as HTMLSelectElement)
                      .value as CronFormState["failureAlertDeliveryMode"],
                  })}
              >
                <option value="announce">${t("cron.form.failureAlertAnnounce")}</option>
                <option value="webhook">${t("cron.form.failureAlertWebhook")}</option>
              </select>
            `,
          })}
          ${renderRow({
            label: t("cron.form.failureAlertAccountId"),
            control: html`
              <input
                .value=${props.form.failureAlertAccountId}
                placeholder=${t("cron.form.failureAlertAccountPlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({
                    failureAlertAccountId: (e.target as HTMLInputElement).value,
                  })}
              />
            `,
          })}
        `
      : nothing}
  `;
}

// ── Run history ──

function renderRunsSection(props: CronProps) {
  const runs = props.runs.toSorted((a, b) =>
    props.runsSortDir === "asc" ? a.ts - b.ts : b.ts - a.ts,
  );
  const runStatusOptions = getRunStatusOptions();
  const runDeliveryOptions = getRunDeliveryOptions();
  const selectedStatusLabels = runStatusOptions
    .filter((option) => props.runsStatuses.includes(option.value))
    .map((option) => option.label);
  const selectedDeliveryLabels = runDeliveryOptions
    .filter((option) => props.runsDeliveryStatuses.includes(option.value))
    .map((option) => option.label);
  const statusSummary = summarizeSelection(selectedStatusLabels, t("cron.runs.allStatuses"));
  const deliverySummary = summarizeSelection(selectedDeliveryLabels, t("cron.runs.allDelivery"));
  return html`
    <div class="cron-runs">
      <div class="cron-run-filters">
        <label class="field cron-run-filter-search">
          <span>${t("cron.runs.searchRuns")}</span>
          <input
            .value=${props.runsQuery}
            placeholder=${t("cron.runs.searchPlaceholder")}
            @input=${(e: Event) =>
              props.onRunsFiltersChange({ cronRunsQuery: (e.target as HTMLInputElement).value })}
          />
        </label>
        ${renderFilterDropdown({
          id: "status",
          title: t("cron.runs.status"),
          summary: statusSummary,
          options: runStatusOptions,
          selected: props.runsStatuses,
          onToggle: (value, checked) => {
            const next = toggleSelection(props.runsStatuses, value as CronRunsStatusValue, checked);
            void props.onRunsFiltersChange({ cronRunsStatuses: next });
          },
          onClear: () => {
            void props.onRunsFiltersChange({ cronRunsStatuses: [] });
          },
        })}
        ${renderFilterDropdown({
          id: "delivery",
          title: t("cron.runs.delivery"),
          summary: deliverySummary,
          options: runDeliveryOptions,
          selected: props.runsDeliveryStatuses,
          onToggle: (value, checked) => {
            const next = toggleSelection(
              props.runsDeliveryStatuses,
              value as CronDeliveryStatus,
              checked,
            );
            void props.onRunsFiltersChange({ cronRunsDeliveryStatuses: next });
          },
          onClear: () => {
            void props.onRunsFiltersChange({ cronRunsDeliveryStatuses: [] });
          },
        })}
        <label class="field">
          <span>${t("cron.jobs.sort")}</span>
          <select
            .value=${props.runsSortDir}
            @change=${(e: Event) =>
              props.onRunsFiltersChange({
                cronRunsSortDir: (e.target as HTMLSelectElement).value as CronSortDir,
              })}
          >
            <option value="desc">${t("cron.runs.newestFirst")}</option>
            <option value="asc">${t("cron.runs.oldestFirst")}</option>
          </select>
        </label>
      </div>
      ${runs.length === 0
        ? html`<div class="muted cron-runs__empty">${t("cron.runs.noMatching")}</div>`
        : html`
            <div class="cron-runs__list">
              ${runs.map((entry) => renderRun(entry, props.basePath, props.onNavigateToChat))}
            </div>
          `}
      ${props.runsHasMore
        ? html`
            <button
              class="btn btn--sm cron-load-more"
              ?disabled=${props.runsLoadingMore}
              @click=${props.onLoadMoreRuns}
            >
              ${props.runsLoadingMore ? t("cron.list.loading") : t("cron.runs.loadMore")}
            </button>
          `
        : nothing}
    </div>
  `;
}

function formatRunNextLabel(nextRunAtMs: number, nowMs = Date.now()) {
  const rel = formatRelativeTimestamp(nextRunAtMs);
  return nextRunAtMs > nowMs ? t("cron.runEntry.next", { rel }) : t("cron.runEntry.due", { rel });
}

function runStatusLabel(value: string): string {
  switch (value) {
    case "ok":
      return t("cron.runs.runStatusOk");
    case "error":
      return t("cron.runs.runStatusError");
    case "skipped":
      return t("cron.runs.runStatusSkipped");
    default:
      return t("cron.runs.runStatusUnknown");
  }
}

function runDeliveryLabel(value: string): string {
  switch (value) {
    case "delivered":
      return t("cron.runs.deliveryDelivered");
    case "not-delivered":
      return t("cron.runs.deliveryNotDelivered");
    case "not-requested":
      return t("cron.runs.deliveryNotRequested");
    default:
      return t("cron.runs.deliveryUnknown");
  }
}

function renderRun(
  entry: CronRunLogEntry,
  basePath: string,
  onNavigateToChat?: (sessionKey: string) => void,
) {
  const chatUrl =
    typeof entry.sessionKey === "string" && entry.sessionKey.trim().length > 0
      ? `${pathForRoute("chat", basePath)}${searchForSession(entry.sessionKey)}`
      : null;
  const status = runStatusLabel(entry.status ?? "unknown");
  const delivery = runDeliveryLabel(entry.deliveryStatus ?? "not-requested");
  const usage = entry.usage;
  const usageSummary =
    usage && typeof usage.total_tokens === "number"
      ? `${usage.total_tokens} tokens`
      : usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
        ? `${usage.input_tokens} in / ${usage.output_tokens} out`
        : null;
  const bodySource = entry.summary || entry.error || t("cron.runEntry.noSummary");
  const showErrorInMeta = Boolean(entry.error) && Boolean(entry.summary);
  return html`
    <div class="list-item cron-run-entry">
      <div class="cron-run-entry__header">
        <div class="list-main cron-run-entry__main">
          <div class="list-title cron-run-entry__title">
            ${entry.jobName ?? entry.jobId}
            <span class="muted"> · ${status}</span>
          </div>
          <div class="chip-row" style="margin-top: 4px;">
            <span class="chip">${delivery}</span>
            ${entry.model ? html`<span class="chip">${entry.model}</span>` : nothing}
            ${entry.provider ? html`<span class="chip">${entry.provider}</span>` : nothing}
            ${usageSummary ? html`<span class="chip">${usageSummary}</span>` : nothing}
          </div>
        </div>
        <div class="list-meta cron-run-entry__meta">
          <div>${formatMs(entry.ts)}</div>
          ${typeof entry.runAtMs === "number"
            ? html`<div class="muted">${t("cron.runEntry.runAt")} ${formatMs(entry.runAtMs)}</div>`
            : nothing}
          <div class="muted">${entry.durationMs ?? 0}ms</div>
          ${typeof entry.nextRunAtMs === "number"
            ? html`<div class="muted">${formatRunNextLabel(entry.nextRunAtMs)}</div>`
            : nothing}
          ${chatUrl
            ? html`<div>
                <a
                  class="session-link"
                  href=${chatUrl}
                  @click=${(e: MouseEvent) => {
                    if (
                      e.defaultPrevented ||
                      e.button !== 0 ||
                      e.metaKey ||
                      e.ctrlKey ||
                      e.shiftKey ||
                      e.altKey
                    ) {
                      return;
                    }
                    if (onNavigateToChat && entry.sessionKey) {
                      e.preventDefault();
                      onNavigateToChat(entry.sessionKey);
                    }
                  }}
                  >${t("cron.runEntry.openRunChat")}</a
                >
              </div>`
            : nothing}
          ${showErrorInMeta ? html`<div class="muted">${entry.error}</div>` : nothing}
          ${entry.deliveryError ? html`<div class="muted">${entry.deliveryError}</div>` : nothing}
        </div>
      </div>
      <div class="cron-run-entry__body chat-text">
        ${unsafeHTML(toSanitizedMarkdownHtml(bodySource))}
      </div>
    </div>
  `;
}
