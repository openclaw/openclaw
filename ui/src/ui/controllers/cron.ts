import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  CronJob,
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronJobsListResult,
  CronJobsSortBy,
  CronRunScope,
  CronRunLogEntry,
  CronRunsResult,
  CronRunsStatusFilter,
  CronRunsStatusValue,
  CronSortDir,
  CronStatus,
} from "../types.ts";
import { CRON_CHANNEL_LAST } from "../ui-types.ts";
import type { CronFormState } from "../ui-types.ts";

export type CronFieldKey =
  | "name"
  | "scheduleAt"
  | "everyAmount"
  | "cronExpr"
  | "staggerAmount"
  | "payloadText"
  | "payloadModel"
  | "payloadThinking"
  | "timeoutSeconds"
  | "deliveryTo";

export type CronFieldErrors = Partial<Record<CronFieldKey, string>>;

export type CronState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronLoading: boolean;
  cronJobsLoadingMore: boolean;
  cronJobs: CronJob[];
  cronJobsTotal: number;
  cronJobsHasMore: boolean;
  cronJobsNextOffset: number | null;
  cronJobsLimit: number;
  cronJobsQuery: string;
  cronJobsEnabledFilter: CronJobsEnabledFilter;
  cronJobsSortBy: CronJobsSortBy;
  cronJobsSortDir: CronSortDir;
  cronStatus: CronStatus | null;
  cronError: string | null;
  cronForm: CronFormState;
  cronFieldErrors: CronFieldErrors;
  cronEditingJobId: string | null;
  cronRunsJobId: string | null;
  cronRunsLoadingMore: boolean;
  cronRuns: CronRunLogEntry[];
  cronRunsTotal: number;
  cronRunsHasMore: boolean;
  cronRunsNextOffset: number | null;
  cronRunsLimit: number;
  cronRunsScope: CronRunScope;
  cronRunsStatuses: CronRunsStatusValue[];
  cronRunsDeliveryStatuses: CronDeliveryStatus[];
  cronRunsStatusFilter: CronRunsStatusFilter;
  cronRunsQuery: string;
  cronRunsSortDir: CronSortDir;
  cronBusy: boolean;
};

export type CronModelSuggestionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronModelSuggestions: string[];
};

export function supportsAnnounceDelivery(
  form: Pick<CronFormState, "sessionTarget" | "payloadKind">,
) {
  return form.sessionTarget === "isolated" && form.payloadKind === "agentTurn";
}

export function normalizeCronFormState(form: CronFormState): CronFormState {
  if (form.deliveryMode !== "announce") {
    return form;
  }
  if (supportsAnnounceDelivery(form)) {
    return form;
  }
  return {
    ...form,
    deliveryMode: "none",
  };
}

export function validateCronForm(form: CronFormState): CronFieldErrors {
  const errors: CronFieldErrors = {};
  if (!form.name.trim()) {
    errors.name = "Name is required.";
  }
  if (form.scheduleKind === "at") {
    const ms = Date.parse(form.scheduleAt);
    if (!Number.isFinite(ms)) {
      errors.scheduleAt = "Enter a valid date/time.";
    }
  } else if (form.scheduleKind === "every") {
    const amount = toNumber(form.everyAmount, 0);
    if (amount <= 0) {
      errors.everyAmount = "Interval must be greater than 0.";
    }
  } else {
    if (!form.cronExpr.trim()) {
      errors.cronExpr = "Cron expression is required.";
    }
    if (!form.scheduleExact) {
      const staggerAmount = form.staggerAmount.trim();
      if (staggerAmount) {
        const stagger = toNumber(staggerAmount, 0);
        if (stagger <= 0) {
          errors.staggerAmount = "Stagger must be greater than 0.";
        }
      }
    }
  }
  if (!form.payloadText.trim()) {
    errors.payloadText =
      form.payloadKind === "systemEvent"
        ? "System text is required."
        : "Agent message is required.";
  }
  if (form.payloadKind === "agentTurn") {
    const timeoutRaw = form.timeoutSeconds.trim();
    if (timeoutRaw) {
      const timeout = toNumber(timeoutRaw, 0);
      if (timeout <= 0) {
        errors.timeoutSeconds = "If set, timeout must be greater than 0 seconds.";
      }
    }
  }
  if (form.deliveryMode === "webhook") {
    const target = form.deliveryTo.trim();
    if (!target) {
      errors.deliveryTo = "Webhook URL is required.";
    } else if (!/^https?:\/\//i.test(target)) {
      errors.deliveryTo = "Webhook URL must start with http:// or https://.";
    }
  }
  return errors;
}

export function hasCronFormErrors(errors: CronFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export async function loadCronStatus(state: CronState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<CronStatus>("cron.status", {});
    state.cronStatus = res;
  } catch (err) {
    state.cronError = String(err);
  }
}

export async function loadCronModelSuggestions(state: CronModelSuggestionsState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request("models.list", {});
    const models = (res as { models?: unknown[] } | null)?.models;
    if (!Array.isArray(models)) {
      state.cronModelSuggestions = [];
      return;
    }
    const ids = models
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const id = (entry as { id?: unknown }).id;
        return typeof id === "string" ? id.trim() : "";
      })
      .filter(Boolean);
    state.cronModelSuggestions = Array.from(new Set(ids)).toSorted((a, b) => a.localeCompare(b));
  } catch {
    state.cronModelSuggestions = [];
  }
}

export async function loadCronJobs(state: CronState) {
  return await loadCronJobsPage(state, { append: false });
}

function normalizeCronPageMeta(params: {
  totalRaw: unknown;
  limitRaw: unknown;
  offsetRaw: unknown;
  nextOffsetRaw: unknown;
  hasMoreRaw: unknown;
  pageCount: number;
}) {
  const total =
    typeof params.totalRaw === "number" && Number.isFinite(params.totalRaw)
      ? Math.max(0, Math.floor(params.totalRaw))
      : params.pageCount;
  const limit =
    typeof params.limitRaw === "number" && Number.isFinite(params.limitRaw)
      ? Math.max(1, Math.floor(params.limitRaw))
      : Math.max(1, params.pageCount);
  const offset =
    typeof params.offsetRaw === "number" && Number.isFinite(params.offsetRaw)
      ? Math.max(0, Math.floor(params.offsetRaw))
      : 0;
  const hasMore =
    typeof params.hasMoreRaw === "boolean"
      ? params.hasMoreRaw
      : offset + params.pageCount < Math.max(total, offset + params.pageCount);
  const nextOffset =
    typeof params.nextOffsetRaw === "number" && Number.isFinite(params.nextOffsetRaw)
      ? Math.max(0, Math.floor(params.nextOffsetRaw))
      : hasMore
        ? offset + params.pageCount
        : null;
  return { total, limit, offset, hasMore, nextOffset };
}

export async function loadCronJobsPage(state: CronState, opts?: { append?: boolean }) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.cronLoading || state.cronJobsLoadingMore) {
    return;
  }
  const append = opts?.append === true;
  if (append) {
    if (!state.cronJobsHasMore) {
      return;
    }
    state.cronJobsLoadingMore = true;
  } else {
    state.cronLoading = true;
  }
  state.cronError = null;
  try {
    const offset = append ? Math.max(0, state.cronJobsNextOffset ?? state.cronJobs.length) : 0;
    const res = await state.client.request<CronJobsListResult>("cron.list", {
      includeDisabled: state.cronJobsEnabledFilter === "all",
      limit: state.cronJobsLimit,
      offset,
      query: state.cronJobsQuery.trim() || undefined,
      enabled: state.cronJobsEnabledFilter,
      sortBy: state.cronJobsSortBy,
      sortDir: state.cronJobsSortDir,
    });
    const jobs = Array.isArray(res.jobs) ? res.jobs : [];
    state.cronJobs = append ? [...state.cronJobs, ...jobs] : jobs;
    const meta = normalizeCronPageMeta({
      totalRaw: res.total,
      limitRaw: res.limit,
      offsetRaw: res.offset,
      nextOffsetRaw: res.nextOffset,
      hasMoreRaw: res.hasMore,
      pageCount: jobs.length,
    });
    state.cronJobsTotal = Math.max(meta.total, state.cronJobs.length);
    state.cronJobsHasMore = meta.hasMore;
    state.cronJobsNextOffset = meta.nextOffset;
    if (
      state.cronEditingJobId &&
      !state.cronJobs.some((job) => job.id === state.cronEditingJobId)
    ) {
      clearCronEditState(state);
    }
  } catch (err) {
    state.cronError = String(err);
  } finally {
    if (append) {
      state.cronJobsLoadingMore = false;
    } else {
      state.cronLoading = false;
    }
  }
}

export async function loadMoreCronJobs(state: CronState) {
  await loadCronJobsPage(state, { append: true });
}

export async function reloadCronJobs(state: CronState) {
  await loadCronJobsPage(state, { append: false });
}

export function updateCronJobsFilter(
  state: CronState,
  patch: Partial<
    Pick<
      CronState,
      "cronJobsQuery" | "cronJobsEnabledFilter" | "cronJobsSortBy" | "cronJobsSortDir"
    >
  >,
) {
  if (typeof patch.cronJobsQuery === "string") {
    state.cronJobsQuery = patch.cronJobsQuery;
  }
  if (patch.cronJobsEnabledFilter) {
    state.cronJobsEnabledFilter = patch.cronJobsEnabledFilter;
  }
  if (patch.cronJobsSortBy) {
    state.cronJobsSortBy = patch.cronJobsSortBy;
  }
  if (patch.cronJobsSortDir) {
    state.cronJobsSortDir = patch.cronJobsSortDir;
  }
}

function clearCronEditState(state: CronState) {
  state.cronEditingJobId = null;
}

function resetCronFormToDefaults(state: CronState) {
  state.cronForm = { ...DEFAULT_CRON_FORM };
  state.cronFieldErrors = validateCronForm(state.cronForm);
}

function formatDateTimeLocal(input: string): string {
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function parseEverySchedule(everyMs: number): Pick<CronFormState, "everyAmount" | "everyUnit"> {
  if (everyMs % 86_400_000 === 0) {
    return { everyAmount: String(Math.max(1, everyMs / 86_400_000)), everyUnit: "days" };
  }
  if (everyMs % 3_600_000 === 0) {
    return { everyAmount: String(Math.max(1, everyMs / 3_600_000)), everyUnit: "hours" };
  }
  const minutes = Math.max(1, Math.ceil(everyMs / 60_000));
  return { everyAmount: String(minutes), everyUnit: "minutes" };
}

function parseStaggerSchedule(
  staggerMs?: number,
): Pick<CronFormState, "scheduleExact" | "staggerAmount" | "staggerUnit"> {
  if (staggerMs === 0) {
    return { scheduleExact: true, staggerAmount: "", staggerUnit: "seconds" };
  }
  if (typeof staggerMs !== "number" || !Number.isFinite(staggerMs) || staggerMs < 0) {
    return { scheduleExact: false, staggerAmount: "", staggerUnit: "seconds" };
  }
  if (staggerMs % 60_000 === 0) {
    return {
      scheduleExact: false,
      staggerAmount: String(Math.max(1, staggerMs / 60_000)),
      staggerUnit: "minutes",
    };
  }
  return {
    scheduleExact: false,
    staggerAmount: String(Math.max(1, Math.ceil(staggerMs / 1_000))),
    staggerUnit: "seconds",
  };
}

function jobToForm(job: CronJob, prev: CronFormState): CronFormState {
  const next: CronFormState = {
    ...prev,
    name: job.name,
    description: job.description ?? "",
    agentId: job.agentId ?? "",
    clearAgent: false,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun ?? false,
    scheduleKind: job.schedule.kind,
    scheduleAt: "",
    everyAmount: prev.everyAmount,
    everyUnit: prev.everyUnit,
    cronExpr: prev.cronExpr,
    cronTz: "",
    scheduleExact: false,
    staggerAmount: "",
    staggerUnit: "seconds",
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payloadKind: job.payload.kind,
    payloadText: job.payload.kind === "systemEvent" ? job.payload.text : job.payload.message,
    payloadModel: job.payload.kind === "agentTurn" ? (job.payload.model ?? "") : "",
    payloadThinking: job.payload.kind === "agentTurn" ? (job.payload.thinking ?? "") : "",
    deliveryMode: job.delivery?.mode ?? "none",
    deliveryChannel: job.delivery?.channel ?? CRON_CHANNEL_LAST,
    deliveryTo: job.delivery?.to ?? "",
    deliveryBestEffort: job.delivery?.bestEffort ?? false,
    timeoutSeconds:
      job.payload.kind === "agentTurn" && typeof job.payload.timeoutSeconds === "number"
        ? String(job.payload.timeoutSeconds)
        : "",
  };

  if (job.schedule.kind === "at") {
    next.scheduleAt = formatDateTimeLocal(job.schedule.at);
  } else if (job.schedule.kind === "every") {
    const parsed = parseEverySchedule(job.schedule.everyMs);
    next.everyAmount = parsed.everyAmount;
    next.everyUnit = parsed.everyUnit;
  } else {
    next.cronExpr = job.schedule.expr;
    next.cronTz = job.schedule.tz ?? "";
    const staggerFields = parseStaggerSchedule(job.schedule.staggerMs);
    next.scheduleExact = staggerFields.scheduleExact;
    next.staggerAmount = staggerFields.staggerAmount;
    next.staggerUnit = staggerFields.staggerUnit;
  }

  return normalizeCronFormState(next);
}

export function buildCronSchedule(form: CronFormState) {
  if (form.scheduleKind === "at") {
    const ms = Date.parse(form.scheduleAt);
    if (!Number.isFinite(ms)) {
      throw new Error("Invalid run time.");
    }
    return { kind: "at" as const, at: new Date(ms).toISOString() };
  }
  if (form.scheduleKind === "every") {
    const amount = toNumber(form.everyAmount, 0);
    if (amount <= 0) {
      throw new Error("Invalid interval amount.");
    }
    const unit = form.everyUnit;
    const mult = unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
    return { kind: "every" as const, everyMs: amount * mult };
  }
  const expr = form.cronExpr.trim();
  if (!expr) {
    throw new Error("Cron expression required.");
  }
  if (form.scheduleExact) {
    return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined, staggerMs: 0 };
  }
  const staggerAmount = form.staggerAmount.trim();
  if (!staggerAmount) {
    return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined };
  }
  const staggerValue = toNumber(staggerAmount, 0);
  if (staggerValue <= 0) {
    throw new Error("Invalid stagger amount.");
  }
  const staggerMs = form.staggerUnit === "minutes" ? staggerValue * 60_000 : staggerValue * 1_000;
  return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined, staggerMs };
}

export function buildCronPayload(form: CronFormState) {
  if (form.payloadKind === "systemEvent") {
    const text = form.payloadText.trim();
    if (!text) {
      throw new Error("System event text required.");
    }
    return { kind: "systemEvent" as const, text };
  }
  const message = form.payloadText.trim();
  if (!message) {
    throw new Error("Agent message required.");
  }
  const payload: {
    kind: "agentTurn";
    message: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
  } = { kind: "agentTurn", message };
  const model = form.payloadModel.trim();
  if (model) {
    payload.model = model;
  }
  const thinking = form.payloadThinking.trim();
  if (thinking) {
    payload.thinking = thinking;
  }
  const timeoutSeconds = toNumber(form.timeoutSeconds, 0);
  if (timeoutSeconds > 0) {
    payload.timeoutSeconds = timeoutSeconds;
  }
  return payload;
}

export async function addCronJob(state: CronState) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    const form = normalizeCronFormState(state.cronForm);
    if (form !== state.cronForm) {
      state.cronForm = form;
    }
    const fieldErrors = validateCronForm(form);
    state.cronFieldErrors = fieldErrors;
    if (hasCronFormErrors(fieldErrors)) {
      return;
    }

    const schedule = buildCronSchedule(form);
    const payload = buildCronPayload(form);
    const selectedDeliveryMode = form.deliveryMode;
    const delivery =
      selectedDeliveryMode && selectedDeliveryMode !== "none"
        ? {
            mode: selectedDeliveryMode,
            channel:
              selectedDeliveryMode === "announce"
                ? form.deliveryChannel.trim() || "last"
                : undefined,
            to: form.deliveryTo.trim() || undefined,
            bestEffort: form.deliveryBestEffort,
          }
        : undefined;
    const agentId = form.clearAgent ? null : form.agentId.trim();
    const job = {
      name: form.name.trim(),
      description: form.description.trim(),
      agentId: agentId === null ? null : agentId || undefined,
      enabled: form.enabled,
      deleteAfterRun: form.deleteAfterRun,
      schedule,
      sessionTarget: form.sessionTarget,
      wakeMode: form.wakeMode,
      payload,
      delivery,
    };
    if (!job.name) {
      throw new Error("Name required.");
    }
    if (state.cronEditingJobId) {
      await state.client.request("cron.update", {
        id: state.cronEditingJobId,
        patch: job,
      });
      clearCronEditState(state);
    } else {
      await state.client.request("cron.add", job);
      resetCronFormToDefaults(state);
    }
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function toggleCronJob(state: CronState, job: CronJob, enabled: boolean) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.update", { id: job.id, patch: { enabled } });
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function runCronJob(state: CronState, job: CronJob) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.run", { id: job.id, mode: "force" });
    if (state.cronRunsScope === "all") {
      await loadCronRuns(state, null);
    } else {
      await loadCronRuns(state, job.id);
    }
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function removeCronJob(state: CronState, job: CronJob) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.remove", { id: job.id });
    if (state.cronEditingJobId === job.id) {
      clearCronEditState(state);
    }
    if (state.cronRunsJobId === job.id) {
      state.cronRunsJobId = null;
      state.cronRuns = [];
      state.cronRunsTotal = 0;
      state.cronRunsHasMore = false;
      state.cronRunsNextOffset = null;
    }
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function loadCronRuns(
  state: CronState,
  jobId: string | null,
  opts?: { append?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const scope = state.cronRunsScope;
  const activeJobId = jobId ?? state.cronRunsJobId;
  if (scope === "job" && !activeJobId) {
    state.cronRuns = [];
    state.cronRunsTotal = 0;
    state.cronRunsHasMore = false;
    state.cronRunsNextOffset = null;
    return;
  }
  const append = opts?.append === true;
  if (append && !state.cronRunsHasMore) {
    return;
  }
  try {
    if (append) {
      state.cronRunsLoadingMore = true;
    }
    const offset = append ? Math.max(0, state.cronRunsNextOffset ?? state.cronRuns.length) : 0;
    const res = await state.client.request<CronRunsResult>("cron.runs", {
      scope,
      id: scope === "job" ? (activeJobId ?? undefined) : undefined,
      limit: state.cronRunsLimit,
      offset,
      statuses: state.cronRunsStatuses.length > 0 ? state.cronRunsStatuses : undefined,
      status: state.cronRunsStatusFilter,
      deliveryStatuses:
        state.cronRunsDeliveryStatuses.length > 0 ? state.cronRunsDeliveryStatuses : undefined,
      query: state.cronRunsQuery.trim() || undefined,
      sortDir: state.cronRunsSortDir,
    });
    const entries = Array.isArray(res.entries) ? res.entries : [];
    state.cronRuns =
      append && (scope === "all" || state.cronRunsJobId === activeJobId)
        ? [...state.cronRuns, ...entries]
        : entries;
    if (scope === "job") {
      state.cronRunsJobId = activeJobId ?? null;
    }
    const meta = normalizeCronPageMeta({
      totalRaw: res.total,
      limitRaw: res.limit,
      offsetRaw: res.offset,
      nextOffsetRaw: res.nextOffset,
      hasMoreRaw: res.hasMore,
      pageCount: entries.length,
    });
    state.cronRunsTotal = Math.max(meta.total, state.cronRuns.length);
    state.cronRunsHasMore = meta.hasMore;
    state.cronRunsNextOffset = meta.nextOffset;
  } catch (err) {
    state.cronError = String(err);
  } finally {
    if (append) {
      state.cronRunsLoadingMore = false;
    }
  }
}

export async function loadMoreCronRuns(state: CronState) {
  if (state.cronRunsScope === "job" && !state.cronRunsJobId) {
    return;
  }
  await loadCronRuns(state, state.cronRunsJobId, { append: true });
}

export function updateCronRunsFilter(
  state: CronState,
  patch: Partial<
    Pick<
      CronState,
      | "cronRunsScope"
      | "cronRunsStatuses"
      | "cronRunsDeliveryStatuses"
      | "cronRunsStatusFilter"
      | "cronRunsQuery"
      | "cronRunsSortDir"
    >
  >,
) {
  if (patch.cronRunsScope) {
    state.cronRunsScope = patch.cronRunsScope;
  }
  if (Array.isArray(patch.cronRunsStatuses)) {
    state.cronRunsStatuses = patch.cronRunsStatuses;
    state.cronRunsStatusFilter =
      patch.cronRunsStatuses.length === 1 ? patch.cronRunsStatuses[0] : "all";
  }
  if (Array.isArray(patch.cronRunsDeliveryStatuses)) {
    state.cronRunsDeliveryStatuses = patch.cronRunsDeliveryStatuses;
  }
  if (patch.cronRunsStatusFilter) {
    state.cronRunsStatusFilter = patch.cronRunsStatusFilter;
    state.cronRunsStatuses =
      patch.cronRunsStatusFilter === "all" ? [] : [patch.cronRunsStatusFilter];
  }
  if (typeof patch.cronRunsQuery === "string") {
    state.cronRunsQuery = patch.cronRunsQuery;
  }
  if (patch.cronRunsSortDir) {
    state.cronRunsSortDir = patch.cronRunsSortDir;
  }
}

export function startCronEdit(state: CronState, job: CronJob) {
  state.cronEditingJobId = job.id;
  state.cronRunsJobId = job.id;
  state.cronForm = jobToForm(job, state.cronForm);
  state.cronFieldErrors = validateCronForm(state.cronForm);
}

function buildCloneName(name: string, existingNames: Set<string>) {
  const base = name.trim() || "Job";
  const first = `${base} copy`;
  if (!existingNames.has(first.toLowerCase())) {
    return first;
  }
  let index = 2;
  while (index < 1000) {
    const next = `${base} copy ${index}`;
    if (!existingNames.has(next.toLowerCase())) {
      return next;
    }
    index += 1;
  }
  return `${base} copy ${Date.now()}`;
}

export function startCronClone(state: CronState, job: CronJob) {
  clearCronEditState(state);
  state.cronRunsJobId = job.id;
  const existingNames = new Set(state.cronJobs.map((entry) => entry.name.trim().toLowerCase()));
  const cloned = jobToForm(job, state.cronForm);
  cloned.name = buildCloneName(job.name, existingNames);
  state.cronForm = cloned;
  state.cronFieldErrors = validateCronForm(state.cronForm);
}

export function cancelCronEdit(state: CronState) {
  clearCronEditState(state);
  resetCronFormToDefaults(state);
}
