import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveCronTriggerMinIntervalMs } from "../../../../src/config/cron-limits.js";
import { isSystemMonitorDeclaration } from "../../../../src/cron/system-owned-declaration.js";
import { isSystemOwnedCronPayloadKind } from "../../../../src/cron/types.js";
import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  CronJob,
  CronJobsListResult,
  CronRunResult,
  CronStatus,
  CronPayload,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import { toNumber } from "../format.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";
import { parseCronDurationMs } from "./decimal.ts";
import {
  formatDateTimeLocal,
  parseEverySchedule,
  durationMsToSecondsString,
  parseStaggerSchedule,
  hasUnchangedCronSchedule,
  buildCronSchedule,
} from "./form-schedule.ts";
import { clearCronRunsPage, loadCronRuns, retireCronRunsRequest } from "./runs.ts";
import type { CronFieldErrors, CronFormState, CronState } from "./types.ts";

export { loadCronScopeStats } from "./scope.ts";

const CRON_CHANNEL_LAST = "last";
function isCronPayload(value: unknown): value is CronPayload {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "systemEvent") {
    return typeof value.text === "string";
  }
  if (value.kind === "agentTurn") {
    return typeof value.message === "string";
  }
  if (value.kind === "command") {
    return Array.isArray(value.argv) && value.argv.every((arg) => typeof arg === "string");
  }
  if (value.kind === "script") {
    return typeof value.script === "string";
  }
  if (isSystemOwnedCronPayloadKind(value.kind)) {
    return true;
  }
  return false;
}

function isCronFormSessionTarget(value: string): value is CronFormState["sessionTarget"] {
  return (
    value === "main" ||
    value === "isolated" ||
    value === "current" ||
    (value.startsWith("session:") && value.length > "session:".length)
  );
}

export function getCronJobPayload(job: CronJob): CronPayload | null {
  const payload = (job as { payload?: unknown }).payload;
  return isCronPayload(payload) ? payload : null;
}

function hasCronJobPayload(job: CronJob): boolean {
  return getCronJobPayload(job) !== null;
}

const DEFAULT_CRON_FORM: CronFormState = {
  name: "",
  description: "",
  agentId: "",
  sessionKey: "",
  clearAgent: false,
  enabled: true,
  deleteAfterRun: false,
  scheduleKind: "every",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 7 * * *",
  cronTz: "",
  scheduleExact: false,
  staggerAmount: "",
  staggerUnit: "seconds",
  triggerEnabled: false,
  triggerScript: "",
  triggerOnce: false,
  sessionTarget: "isolated",
  wakeMode: "now",
  payloadKind: "agentTurn",
  payloadLocked: false,
  payloadText: "",
  payloadModel: "",
  payloadThinking: "",
  payloadLightContext: false,
  deliveryMode: "none",
  deliveryChannel: "last",
  deliveryTo: "",
  deliveryAccountId: "",
  deliveryBestEffort: false,
  deliveryThreadId: undefined,
  deliveryCompletionDestination: undefined,
  deliveryFailureDestination: undefined,
  failureAlertMode: "inherit",
  failureAlertAfter: "",
  failureAlertCooldownSeconds: "",
  failureAlertChannel: "last",
  failureAlertTo: "",
  failureAlertDeliveryMode: "",
  failureAlertAccountId: "",
  timeoutSeconds: "",
};

export function createInitialCronState(
  snapshot: Partial<Pick<CronState, "client" | "connected">> = {},
): CronState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    cronLoading: false,
    cronJobsError: null,
    cronJobsLoadingMore: false,
    cronJobsReloadPending: false,
    cronJobsReloadPendingTableFilters: false,
    cronJobs: [],
    cronJobsSnapshotRevision: null,
    cronJobsTotal: 0,
    cronJobsHasMore: false,
    cronJobsNextOffset: null,
    cronJobsLimit: 50,
    cronJobsQuery: "",
    cronJobsEnabledFilter: "all",
    cronJobsScheduleKindFilter: "all",
    cronJobsLastStatusFilter: "all",
    cronJobsTriggerFilter: "all",
    cronJobsSortBy: "nextRunAtMs",
    cronJobsSortDir: "asc",
    cronAgentId: null,
    cronStatus: null,
    cronScopedTotal: null,
    cronScopedNextWakeAtMs: null,
    cronError: null,
    cronForm: { ...DEFAULT_CRON_FORM },
    cronCreateOpen: false,
    cronFieldErrors: {},
    cronEditingJob: null,
    cronCloningJob: null,
    cronRunsError: null,
    cronRunsJobId: null,
    cronRunsLoadingMore: false,
    cronRuns: [],
    cronRunsTotal: 0,
    cronRunsHasMore: false,
    cronRunsNextOffset: null,
    cronRunsLimit: 50,
    cronRunsScope: "all",
    cronRunsStatuses: [],
    cronRunsDeliveryStatuses: [],
    cronRunsStatusFilter: "all",
    cronRunsQuery: "",
    cronRunsSortDir: "desc",
    cronBusy: false,
  };
}

function supportsAnnounceDelivery(
  form: Pick<CronFormState, "sessionTarget" | "payloadKind" | "payloadLocked">,
) {
  return form.sessionTarget !== "main" && (form.payloadKind === "agentTurn" || form.payloadLocked);
}

export function normalizeCronFormState(
  form: CronFormState,
  changed: Partial<CronFormState> = {},
): CronFormState {
  let normalized = form;
  if (!form.payloadLocked) {
    if (changed.sessionTarget !== undefined) {
      const payloadKind = form.sessionTarget === "main" ? "systemEvent" : "agentTurn";
      if (form.payloadKind !== payloadKind) {
        normalized = { ...normalized, payloadKind };
      }
    } else if (form.payloadKind === "systemEvent" && form.sessionTarget !== "main") {
      normalized = { ...normalized, sessionTarget: "main" };
    } else if (form.payloadKind === "agentTurn" && form.sessionTarget === "main") {
      normalized = { ...normalized, sessionTarget: "isolated" };
    }
  }
  if (normalized.deliveryMode !== "announce" || supportsAnnounceDelivery(normalized)) {
    return normalized;
  }
  return {
    ...normalized,
    deliveryMode: "none",
  };
}

export function validateCronForm(form: CronFormState): CronFieldErrors {
  const errors: CronFieldErrors = {};
  if (!form.name.trim()) {
    errors.name = "cron.errors.nameRequired";
  }
  if (form.scheduleKind === "at") {
    const ms = Date.parse(form.scheduleAt);
    if (!Number.isFinite(ms)) {
      errors.scheduleAt = "cron.errors.scheduleAtInvalid";
    }
  } else if (form.scheduleKind === "every") {
    const everyMs = parseCronDurationMs(form.everyAmount, form.everyUnit);
    if (everyMs === undefined) {
      errors.everyAmount = "cron.errors.everyAmountInvalid";
    } else if (form.triggerEnabled && everyMs < resolveCronTriggerMinIntervalMs()) {
      errors.everyAmount = "cron.errors.triggerIntervalTooShort";
    }
  } else if (form.scheduleKind === "cron") {
    if (!form.cronExpr.trim()) {
      errors.cronExpr = "cron.errors.cronExprRequired";
    }
    if (!form.scheduleExact) {
      const staggerAmount = form.staggerAmount.trim();
      if (staggerAmount && !parseCronDurationMs(staggerAmount, form.staggerUnit, true)) {
        errors.staggerAmount = "cron.errors.staggerAmountInvalid";
      }
    }
  }
  if (form.triggerEnabled) {
    if (form.payloadKind === "script") {
      errors.triggerScript = "cron.errors.triggerScriptPayloadUnsupported";
    } else if (
      form.scheduleKind !== "every" &&
      form.scheduleKind !== "cron" &&
      form.scheduleKind !== "stream"
    ) {
      errors.triggerScript = "cron.errors.triggerScheduleUnsupported";
    } else if (!form.triggerScript.trim()) {
      errors.triggerScript = "cron.errors.triggerScriptRequired";
    }
  }
  if (!form.payloadLocked && !form.payloadText.trim()) {
    errors.payloadText =
      form.payloadKind === "systemEvent"
        ? "cron.errors.systemTextRequired"
        : "cron.errors.agentMessageRequired";
  }
  if (!form.payloadLocked && form.payloadKind === "agentTurn") {
    const timeoutRaw = form.timeoutSeconds.trim();
    if (timeoutRaw) {
      const timeout = toNumber(timeoutRaw, Number.NaN);
      if (!Number.isFinite(timeout) || timeout < 0) {
        errors.timeoutSeconds = "cron.errors.timeoutInvalid";
      }
    }
  }
  if (form.deliveryMode === "webhook") {
    const target = form.deliveryTo.trim();
    if (!target) {
      errors.deliveryTo = "cron.errors.webhookUrlRequired";
    } else if (!/^https?:\/\//i.test(target)) {
      errors.deliveryTo = "cron.errors.webhookUrlInvalid";
    }
  }
  if (form.failureAlertMode === "custom") {
    const afterRaw = form.failureAlertAfter.trim();
    if (afterRaw) {
      const after = toNumber(afterRaw, 0);
      if (!Number.isFinite(after) || after < 1) {
        errors.failureAlertAfter = "Failure alert threshold must be at least 1.";
      }
    }
    const cooldownRaw = form.failureAlertCooldownSeconds.trim();
    if (cooldownRaw && parseFailureAlertCooldownMs(cooldownRaw) === undefined) {
      errors.failureAlertCooldownSeconds = "Cooldown must be finite and 0 or greater.";
    }
  }
  return errors;
}

export function hasCronFormErrors(errors: CronFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

type CronStatusRequest = {
  client: GatewayBrowserClient;
  selectedJob: CronJob | null;
  reportErrors: boolean;
  queued?: Deferred;
};
const activeCronStatusRequests = new WeakMap<CronState, CronStatusRequest>();

function retireCronStatusRequest(state: CronState) {
  activeCronStatusRequests.get(state)?.queued?.resolve();
  activeCronStatusRequests.delete(state);
}

function retireCronStatusFeedback(state: CronState) {
  const request = activeCronStatusRequests.get(state);
  if (request) {
    request.reportErrors = false;
  }
}

export async function loadCronStatus(
  state: CronState,
  opts?: { coalesce?: boolean },
): Promise<void> {
  const client = state.client;
  if (!client || !state.connected || state.canRefresh?.() === false) {
    return;
  }
  const active = activeCronStatusRequests.get(state);
  if (opts?.coalesce && active?.client === client) {
    return (active.queued ??= createDeferredCore()).promise;
  }
  const agentId = state.cronAgentId;
  const selectedJob = state.cronEditingJob;
  const request: CronStatusRequest = {
    client,
    selectedJob,
    reportErrors: !opts?.coalesce || !state.cronBusy,
  };
  activeCronStatusRequests.set(state, request);
  const isCurrent = () =>
    activeCronStatusRequests.get(state) === request &&
    state.connected &&
    state.client === client &&
    state.cronAgentId === agentId;
  const ownsSelectedJob = () =>
    isCurrent() && request.selectedJob === selectedJob && state.cronEditingJob === selectedJob;
  const selectedJobRead = selectedJob
    ? client.request<CronJob>("cron.get", { id: selectedJob.id }).then(
        (fresh) => {
          if (ownsSelectedJob() && fresh.id === selectedJob.id) {
            // Runtime refresh must not replace the editor's saved definition or dirty form.
            selectedJob.state = fresh.state;
          }
        },
        (error: unknown) => {
          if (ownsSelectedJob() && request.reportErrors && (!opts?.coalesce || !request.queued)) {
            state.cronError = formatUiError(error);
          }
        },
      )
    : Promise.resolve();
  try {
    const res = await client.request<CronStatus>("cron.status", {});
    if (isCurrent()) {
      state.cronStatus = res;
    }
  } catch (err) {
    if (!isCurrent() || !request.reportErrors || (opts?.coalesce && request.queued)) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      state.cronStatus = null;
      state.cronError = formatMissingOperatorReadScopeMessage("cron status");
    } else {
      state.cronError = formatUiError(err);
    }
  } finally {
    await selectedJobRead;
    const reload = isCurrent();
    if (activeCronStatusRequests.get(state) === request) {
      activeCronStatusRequests.delete(state);
    }
    if (request.queued) {
      const trailing = reload ? loadCronStatus(state, { coalesce: true }) : undefined;
      // Queued events keep their data freshness without reclaiming retired feedback.
      if (reload && !request.reportErrors) {
        retireCronStatusFeedback(state);
      }
      request.queued.resolve(trailing);
    }
  }
}

function addModelId(target: Set<string>, value: unknown) {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    target.add(trimmed);
  }
}

function addModelConfigIds(target: Set<string>, modelConfig: unknown) {
  if (!modelConfig) {
    return;
  }
  if (typeof modelConfig === "string") {
    addModelId(target, modelConfig);
    return;
  }
  if (typeof modelConfig !== "object") {
    return;
  }
  const record = modelConfig as Record<string, unknown>;
  addModelId(target, record.primary);
  addModelId(target, record.model);
  addModelId(target, record.id);
  addModelId(target, record.value);
  const fallbacks = Array.isArray(record.fallbacks)
    ? record.fallbacks
    : Array.isArray(record.fallback)
      ? record.fallback
      : [];
  for (const fallback of fallbacks) {
    addModelId(target, fallback);
  }
}

export function resolveConfiguredCronModelSuggestions(
  configForm: Record<string, unknown> | null | undefined,
): string[] {
  if (!configForm || typeof configForm !== "object") {
    return [];
  }
  const agents = configForm.agents;
  if (!agents || typeof agents !== "object") {
    return [];
  }
  const out = new Set<string>();
  const defaults = (agents as { defaults?: unknown }).defaults;
  if (defaults && typeof defaults === "object") {
    const defaultsRecord = defaults as Record<string, unknown>;
    addModelConfigIds(out, defaultsRecord.model);
    const defaultsModels = defaultsRecord.models;
    if (defaultsModels && typeof defaultsModels === "object") {
      for (const modelId of Object.keys(defaultsModels as Record<string, unknown>)) {
        addModelId(out, modelId);
      }
    }
  }
  const entries = (agents as { entries?: unknown }).entries;
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const entry of Object.values(entries as Record<string, unknown>)) {
      if (entry && typeof entry === "object") {
        addModelConfigIds(out, (entry as Record<string, unknown>).model);
      }
    }
  }
  return sortUniqueStrings([...out]);
}

async function withCronBusy(
  state: CronState,
  run: (client: GatewayBrowserClient) => Promise<void>,
) {
  const client = state.client;
  if (!client || !state.connected || state.cronBusy) {
    return;
  }
  retireCronStatusFeedback(state);
  state.cronBusy = true;
  state.cronError = null;
  try {
    await run(client);
  } catch (err) {
    state.cronError = formatUiError(err);
  } finally {
    retireCronStatusFeedback(state);
    state.cronBusy = false;
  }
}

function requireCronConfigRevision(revision: string | null | undefined): string {
  if (revision) {
    return revision;
  }
  throw new Error("This automation is missing its configuration revision. Refresh and try again.");
}

function replaceLocalCronJob(state: CronState, updatedJob: CronJob) {
  state.cronJobs = state.cronJobs.map((job) => (job.id === updatedJob.id ? updatedJob : job));
}

function isCronJobChangedError(error: unknown): boolean {
  const details = isRecord(error) && isRecord(error.details) ? error.details : null;
  return details?.code === "CRON_JOB_CHANGED";
}

type CanonicalCronJobsPage = {
  jobs: CronJob[];
  snapshotRevision: string;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

function readCanonicalCronJobsPage(value: unknown, requestedLimit: number): CanonicalCronJobsPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.jobs) ||
    typeof value.snapshotRevision !== "string" ||
    value.snapshotRevision.length === 0 ||
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    typeof value.offset !== "number" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    typeof value.limit !== "number" ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > requestedLimit ||
    value.jobs.length > value.limit ||
    typeof value.hasMore !== "boolean" ||
    (value.nextOffset !== null &&
      (typeof value.nextOffset !== "number" ||
        !Number.isSafeInteger(value.nextOffset) ||
        value.nextOffset < 0))
  ) {
    throw new Error("cron.list returned an invalid inventory page");
  }
  return value as CanonicalCronJobsPage;
}

function assertCanonicalCronJobsCursor(page: CanonicalCronJobsPage, requestedOffset: number) {
  const nextOffset = requestedOffset + page.jobs.length;
  if (
    page.offset !== requestedOffset ||
    !Number.isSafeInteger(nextOffset) ||
    nextOffset > page.total ||
    (page.hasMore
      ? page.nextOffset !== nextOffset || nextOffset <= requestedOffset || nextOffset >= page.total
      : page.nextOffset !== null || nextOffset !== page.total)
  ) {
    throw new Error("cron.list returned an invalid inventory page");
  }
}

function queueCronJobsSnapshotRecovery(state: CronState, tableFilters: boolean) {
  if (state.cronJobsReloadPending) {
    return;
  }
  state.cronJobsReloadPending = true;
  state.cronJobsReloadPendingTableFilters = tableFilters;
}

async function drainPendingCronJobsReload(state: CronState) {
  if (!state.cronJobsReloadPending) {
    return;
  }
  const tableFilters = state.cronJobsReloadPendingTableFilters;
  state.cronJobsReloadPending = false;
  state.cronJobsReloadPendingTableFilters = false;
  await loadCronJobsPage(state, { tableFilters });
}

export async function loadCronJobsPage(
  state: CronState,
  opts?: { append?: boolean; tableFilters?: boolean },
) {
  if (!state.client || !state.connected || state.canRefresh?.() === false) {
    return;
  }
  const append = opts?.append === true;
  if (state.cronLoading || state.cronJobsLoadingMore) {
    if (!append) {
      state.cronJobsReloadPending = true;
      state.cronJobsReloadPendingTableFilters = opts?.tableFilters === true;
    }
    return;
  }
  if (append && !state.cronJobsHasMore) {
    return;
  }
  if (append) {
    state.cronJobsLoadingMore = true;
  } else {
    state.cronLoading = true;
  }
  state.cronJobsError = null;
  try {
    const offset = append ? Math.max(0, state.cronJobsNextOffset ?? state.cronJobs.length) : 0;
    const res = await state.client.request<CronJobsListResult>("cron.list", {
      ...(state.cronSessionFilter ?? (state.cronAgentId ? { agentId: state.cronAgentId } : {})),
      includeDisabled: state.cronJobsEnabledFilter === "all",
      includeDeliveryPreviews: false,
      limit: state.cronJobsLimit,
      offset,
      query: state.cronJobsQuery.trim() || undefined,
      enabled: state.cronJobsEnabledFilter,
      ...(opts?.tableFilters
        ? {
            scheduleKind: state.cronJobsScheduleKindFilter,
            lastRunStatus: state.cronJobsLastStatusFilter,
            trigger: state.cronJobsTriggerFilter,
          }
        : {}),
      sortBy: state.cronJobsSortBy,
      sortDir: state.cronJobsSortDir,
    });
    const page = readCanonicalCronJobsPage(res, state.cronJobsLimit);
    if (
      append &&
      (page.snapshotRevision !== state.cronJobsSnapshotRevision ||
        page.total !== state.cronJobsTotal)
    ) {
      // A changed snapshot can move rows behind the append boundary. Preserve
      // the coherent table and let one serialized page-zero reload recover it.
      queueCronJobsSnapshotRecovery(state, opts?.tableFilters === true);
      return;
    }
    assertCanonicalCronJobsCursor(page, offset);
    const jobs = page.jobs.filter(hasCronJobPayload);
    const nextJobs = append ? [...state.cronJobs, ...jobs] : jobs;
    state.cronJobs = nextJobs;
    state.cronJobsSnapshotRevision = page.snapshotRevision;
    state.cronJobsTotal = page.total;
    state.cronJobsHasMore = page.hasMore;
    state.cronJobsNextOffset = page.nextOffset;
    // A filtered/paged list is not deletion authority. Only an explicit remove
    // may clear an editor opened from an exact job definition.
  } catch (err) {
    state.cronJobsError = formatUiError(err);
  } finally {
    if (append) {
      state.cronJobsLoadingMore = false;
    } else {
      state.cronLoading = false;
    }
    await drainPendingCronJobsReload(state);
  }
}

export function updateCronJobsFilter(
  state: CronState,
  patch: Partial<
    Pick<
      CronState,
      | "cronJobsQuery"
      | "cronJobsEnabledFilter"
      | "cronJobsScheduleKindFilter"
      | "cronJobsLastStatusFilter"
      | "cronJobsTriggerFilter"
      | "cronJobsSortBy"
      | "cronJobsSortDir"
    >
  >,
) {
  if (typeof patch.cronJobsQuery === "string") {
    state.cronJobsQuery = patch.cronJobsQuery;
  }
  state.cronJobsEnabledFilter = patch.cronJobsEnabledFilter ?? state.cronJobsEnabledFilter;
  state.cronJobsScheduleKindFilter =
    patch.cronJobsScheduleKindFilter ?? state.cronJobsScheduleKindFilter;
  state.cronJobsLastStatusFilter = patch.cronJobsLastStatusFilter ?? state.cronJobsLastStatusFilter;
  state.cronJobsTriggerFilter = patch.cronJobsTriggerFilter ?? state.cronJobsTriggerFilter;
  state.cronJobsSortBy = patch.cronJobsSortBy ?? state.cronJobsSortBy;
  state.cronJobsSortDir = patch.cronJobsSortDir ?? state.cronJobsSortDir;
}

function retireCronSelectedJobRead(state: CronState) {
  const request = activeCronStatusRequests.get(state);
  if (request) {
    request.selectedJob = null;
  }
}

function clearCronEditState(state: CronState) {
  retireCronSelectedJobRead(state);
  state.cronError = null;
  state.cronEditingJob = null;
  state.cronCloningJob = null;
}

function resetCronFormToDefaults(state: CronState, agentId: string | null) {
  state.cronCloningJob = null;
  state.cronForm = { ...DEFAULT_CRON_FORM, agentId: agentId ?? "" };
  // A fresh form starts visually clean; validation re-arms on the first change
  // or submit so required-field errors do not greet the user immediately.
  state.cronFieldErrors = {};
}

function isReadOnlyCronPayload(payload: CronPayload | null, declarationKey?: string): boolean {
  return (
    payload?.kind === "command" ||
    payload?.kind === "script" ||
    isSystemOwnedCronPayloadKind(payload?.kind) ||
    isSystemMonitorDeclaration(declarationKey)
  );
}

function jobToForm(job: CronJob, prev: CronFormState): CronFormState {
  const failureAlert = typeof job.failureAlert === "object" ? job.failureAlert : undefined;
  const payload = getCronJobPayload(job);
  const payloadLocked = isReadOnlyCronPayload(payload, job.declarationKey);
  if (!isCronFormSessionTarget(job.sessionTarget)) {
    throw new TypeError(`Invalid cron session target: ${job.sessionTarget}`);
  }
  const next: CronFormState = {
    ...prev,
    name: job.name,
    description: job.description ?? "",
    agentId: job.agentId ?? "",
    sessionKey: job.sessionKey ?? "",
    clearAgent: false,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun ?? job.schedule.kind === "at",
    scheduleKind: job.schedule.kind,
    scheduleAt: "",
    everyAmount: prev.everyAmount,
    everyUnit: prev.everyUnit,
    cronExpr: prev.cronExpr,
    cronTz: "",
    scheduleExact: false,
    staggerAmount: "",
    staggerUnit: "seconds",
    triggerEnabled: job.trigger !== undefined,
    triggerScript: job.trigger?.script ?? "",
    triggerOnce: job.trigger?.once === true,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payloadKind: payload?.kind ?? DEFAULT_CRON_FORM.payloadKind,
    payloadLocked,
    payloadText:
      payload?.kind === "systemEvent"
        ? payload.text
        : payload?.kind === "agentTurn"
          ? payload.message
          : payload?.kind === "command"
            ? payload.argv.join(" ")
            : payload?.kind === "script"
              ? payload.script
              : "",
    payloadModel: payload?.kind === "agentTurn" ? (payload.model ?? "") : "",
    payloadThinking: payload?.kind === "agentTurn" ? (payload.thinking ?? "") : "",
    payloadLightContext: payload?.kind === "agentTurn" ? payload.lightContext === true : false,
    deliveryMode: job.delivery?.mode ?? "none",
    deliveryChannel: job.delivery?.channel ?? CRON_CHANNEL_LAST,
    deliveryTo: job.delivery?.to ?? "",
    deliveryAccountId: job.delivery?.accountId ?? "",
    deliveryBestEffort: job.delivery?.bestEffort ?? false,
    deliveryThreadId: job.delivery?.threadId,
    deliveryCompletionDestination:
      job.delivery?.mode === "announce" ? job.delivery.completionDestination : undefined,
    deliveryFailureDestination: job.delivery?.failureDestination,
    failureAlertMode: job.failureAlert === false ? "disabled" : failureAlert ? "custom" : "inherit",
    failureAlertAfter: typeof failureAlert?.after === "number" ? String(failureAlert.after) : "",
    failureAlertCooldownSeconds:
      typeof failureAlert?.cooldownMs === "number"
        ? durationMsToSecondsString(failureAlert.cooldownMs)
        : "",
    failureAlertChannel: failureAlert?.channel ?? CRON_CHANNEL_LAST,
    failureAlertTo: failureAlert?.to ?? "",
    failureAlertDeliveryMode: failureAlert?.mode ?? "",
    failureAlertAccountId: failureAlert?.accountId ?? "",
    timeoutSeconds:
      payload?.kind === "agentTurn" && typeof payload.timeoutSeconds === "number"
        ? String(payload.timeoutSeconds)
        : "",
  };

  if (job.schedule.kind === "at") {
    next.scheduleAt = formatDateTimeLocal(job.schedule.at);
  } else if (job.schedule.kind === "every") {
    const parsed = parseEverySchedule(job.schedule.everyMs);
    next.everyAmount = parsed.everyAmount;
    next.everyUnit = parsed.everyUnit;
  } else if (job.schedule.kind === "cron") {
    next.cronExpr = job.schedule.expr;
    next.cronTz = job.schedule.tz ?? "";
    const staggerFields = parseStaggerSchedule(job.schedule.staggerMs);
    next.scheduleExact = staggerFields.scheduleExact;
    next.staggerAmount = staggerFields.staggerAmount;
    next.staggerUnit = staggerFields.staggerUnit;
  }
  // Process-backed schedule kinds are shown read-only in the list and have no
  // editable schedule form fields; leave the cron/at/every fields at their defaults.

  return normalizeCronFormState(next);
}

function buildCronPayload(form: CronFormState, source: CronPayload | null, isUpdate: boolean) {
  // Clones carry public restrictions, not the source's capture markers or authority.
  // Updates must omit caps so the Gateway retains that job's existing authority.
  const toolsAllow = !isUpdate && source && "toolsAllow" in source ? source.toolsAllow : undefined;
  const restrictions = toolsAllow ? { toolsAllow: [...toolsAllow] } : {};
  if (form.payloadKind === "systemEvent") {
    const text = form.payloadText.trim();
    if (!text) {
      throw new Error(t("cron.errors.systemEventTextRequired"));
    }
    return { kind: "systemEvent" as const, text, ...restrictions };
  }
  if (form.payloadKind !== "agentTurn") {
    throw new Error(`Cron ${form.payloadKind} payloads are read-only in Control UI.`);
  }
  const message = form.payloadText.trim();
  if (!message) {
    throw new Error(t("cron.errors.agentMessageRequiredShort"));
  }
  const original = source?.kind === "agentTurn" ? source : undefined;
  const cloned = isUpdate ? undefined : original;
  // Blank stored overrides clear on update; a new job leaves them inherited.
  const model =
    form.payloadModel.trim() || (isUpdate && original?.model !== undefined ? null : undefined);
  const thinking =
    form.payloadThinking.trim() ||
    (isUpdate && original?.thinking !== undefined ? null : undefined);
  const timeoutRaw = form.timeoutSeconds.trim();
  const timeoutSeconds = toNumber(timeoutRaw, Number.NaN);
  const lightContext =
    form.payloadLightContext || original?.lightContext !== undefined
      ? form.payloadLightContext
      : undefined;
  return {
    kind: "agentTurn" as const,
    message,
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(timeoutRaw && Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0
      ? { timeoutSeconds }
      : isUpdate && original?.timeoutSeconds !== undefined
        ? { timeoutSeconds: null }
        : {}),
    ...(lightContext !== undefined ? { lightContext } : {}),
    ...restrictions,
    ...(cloned?.fallbacks ? { fallbacks: [...cloned.fallbacks] } : {}),
    ...(cloned?.allowUnsafeExternalContent !== undefined
      ? { allowUnsafeExternalContent: cloned.allowUnsafeExternalContent }
      : {}),
  };
}

function normalizePersistedDeliveryChannel(
  value: string,
  options: { preserveLast?: boolean } = {},
) {
  const channel = value.trim();
  if (!channel) {
    return undefined;
  }
  if (channel === CRON_CHANNEL_LAST) {
    return options.preserveLast ? CRON_CHANNEL_LAST : undefined;
  }
  return channel;
}

function parseFailureAlertCooldownMs(value: string): number | undefined {
  const raw = value.trim();
  const seconds = toNumber(raw, Number.NaN);
  if (!raw || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  // Keep decimal precision; normalize other accepted Number spellings before the same scale.
  const decimal =
    seconds === 0 || parseStrictFiniteNumber(raw) === undefined ? String(seconds) : raw;
  const [coefficient, exponent = "0"] = decimal.split(/[eE]/u);
  const ms = Number(`${coefficient}e${Number(exponent) + 3}`);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : undefined;
}

function buildFailureAlert(
  form: CronFormState,
  source?: CronJob["failureAlert"],
  isUpdate = false,
) {
  if (form.failureAlertMode === "disabled") {
    return false as const;
  }
  if (form.failureAlertMode !== "custom") {
    return isUpdate && source !== undefined ? null : undefined;
  }
  const sourceConfig = source && typeof source === "object" ? source : undefined;
  const existingConfig = isUpdate ? sourceConfig : undefined;
  const after = toNumber(form.failureAlertAfter.trim(), 0);
  const cooldownMs = parseFailureAlertCooldownMs(form.failureAlertCooldownSeconds);
  const accountId = form.failureAlertAccountId.trim();
  const to = form.failureAlertTo.trim();
  return {
    after: after > 0 ? Math.floor(after) : existingConfig?.after !== undefined ? null : undefined,
    channel: normalizePersistedDeliveryChannel(form.failureAlertChannel, {
      preserveLast: Boolean(sourceConfig?.channel),
    }),
    to: to || (existingConfig?.to ? null : undefined),
    ...(cooldownMs !== undefined
      ? { cooldownMs }
      : existingConfig?.cooldownMs !== undefined
        ? { cooldownMs: null }
        : {}),
    mode: form.failureAlertDeliveryMode || (existingConfig?.mode !== undefined ? null : undefined),
    accountId: accountId || (existingConfig?.accountId ? null : undefined),
    includeSkipped: sourceConfig?.includeSkipped,
  };
}

type CronSaveResult = { saved: false } | { saved: true; jobId: string | null };

// cron.add responds with either { created, job } or the bare job read view.
function extractSavedCronJobId(response: unknown): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const container = "job" in response ? (response as { job?: unknown }).job : response;
  if (!container || typeof container !== "object") {
    return null;
  }
  const id = (container as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function addCronJob(state: CronState): Promise<CronSaveResult> {
  let result: CronSaveResult = { saved: false };
  await withCronBusy(state, async (client) => {
    const form = normalizeCronFormState(state.cronForm);
    if (form !== state.cronForm) {
      state.cronForm = form;
    }
    const fieldErrors = validateCronForm(form);
    state.cronFieldErrors = fieldErrors;
    if (hasCronFormErrors(fieldErrors)) {
      return;
    }

    const editingJob = state.cronEditingJob;
    const expectedConfigRevision = editingJob
      ? requireCronConfigRevision(editingJob.configRevision)
      : undefined;
    const sourceJob = editingJob ?? state.cronCloningJob;
    const sourcePayload = sourceJob ? getCronJobPayload(sourceJob) : null;
    // Form fields cannot represent process commands, anchors, or full timestamp precision.
    const schedule =
      sourceJob && hasUnchangedCronSchedule(form, sourceJob)
        ? editingJob
          ? undefined
          : sourceJob.schedule
        : buildCronSchedule(form);
    const preserveLockedPayload = Boolean(
      editingJob &&
      form.payloadLocked &&
      isReadOnlyCronPayload(sourcePayload, sourceJob?.declarationKey),
    );
    const payload = preserveLockedPayload
      ? undefined
      : buildCronPayload(form, sourcePayload, Boolean(editingJob));
    const selectedDeliveryMode = form.deliveryMode;
    const normalizedDeliveryAccountId = form.deliveryAccountId.trim();
    // Update patches need null to clear stored routing; create payloads must
    // omit blanks because the Gateway accountId schema rejects empty strings.
    const deliveryAccountId =
      selectedDeliveryMode === "announce"
        ? normalizedDeliveryAccountId || (editingJob?.delivery?.accountId ? null : undefined)
        : undefined;
    const delivery =
      selectedDeliveryMode && selectedDeliveryMode !== "none"
        ? {
            mode: selectedDeliveryMode,
            channel:
              selectedDeliveryMode === "announce"
                ? normalizePersistedDeliveryChannel(form.deliveryChannel, {
                    preserveLast: Boolean(editingJob?.delivery?.channel),
                  })
                : undefined,
            to:
              form.deliveryTo.trim() ||
              (selectedDeliveryMode === "announce" && editingJob?.delivery?.to ? null : undefined),
            accountId: deliveryAccountId,
            bestEffort: form.deliveryBestEffort,
            ...(form.deliveryThreadId !== undefined ? { threadId: form.deliveryThreadId } : {}),
            ...(selectedDeliveryMode === "announce" && form.deliveryCompletionDestination
              ? { completionDestination: form.deliveryCompletionDestination }
              : {}),
            ...(form.deliveryFailureDestination
              ? { failureDestination: form.deliveryFailureDestination }
              : {}),
          }
        : selectedDeliveryMode === "none"
          ? ({
              mode: "none",
              ...(form.deliveryBestEffort ? { bestEffort: true } : {}),
              ...(form.deliveryThreadId !== undefined ? { threadId: form.deliveryThreadId } : {}),
              ...(form.deliveryFailureDestination
                ? { failureDestination: form.deliveryFailureDestination }
                : {}),
            } as const)
          : undefined;
    const failureAlert = buildFailureAlert(form, sourceJob?.failureAlert, Boolean(editingJob));
    const triggerScript = form.triggerScript.trim();
    const trigger = form.triggerEnabled
      ? editingJob?.trigger?.script === triggerScript &&
        (editingJob.trigger.once === true) === form.triggerOnce
        ? undefined
        : { script: triggerScript, once: form.triggerOnce }
      : editingJob?.trigger
        ? null
        : undefined;
    const agentId = form.clearAgent ? null : form.agentId.trim();
    const sessionKeyRaw = form.sessionKey.trim();
    const sessionKey = sessionKeyRaw || (editingJob?.sessionKey ? null : undefined);
    const job: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description.trim(),
      agentId: agentId === null ? null : agentId || undefined,
      sessionKey,
      enabled: form.enabled,
      ...(form.scheduleKind === "at" || form.scheduleKind === "on-exit"
        ? { deleteAfterRun: form.deleteAfterRun }
        : {}),
      sessionTarget: form.sessionTarget,
      wakeMode: form.wakeMode,
      trigger,
      delivery,
      failureAlert,
    };
    if (schedule) {
      job.schedule = schedule;
    }
    if (sourceJob?.pacing) {
      if (schedule?.kind === "every" || schedule?.kind === "cron") {
        if (!editingJob) {
          job.pacing = { ...sourceJob.pacing };
        }
      } else if (editingJob && schedule) {
        job.pacing = null;
      }
    }
    if (payload) {
      job.payload = payload;
    }
    if (!job.name) {
      throw new Error(t("cron.errors.nameRequiredShort"));
    }
    if (editingJob) {
      const editedJobId = editingJob.id;
      // History navigation can replace the editor while its accepted save is pending.
      const ownsEditor = () => state.cronEditingJob === editingJob && state.cronForm === form;
      try {
        const updatedJob = await client.request<CronJob>("cron.update", {
          id: editedJobId,
          expectedConfigRevision,
          patch: job,
        });
        replaceLocalCronJob(state, updatedJob);
        if (ownsEditor()) {
          startCronEdit(state, updatedJob);
        }
      } catch (error) {
        if (!isCronJobChangedError(error)) {
          if (ownsEditor()) {
            throw error;
          }
          return;
        }
        await reloadCronJobsSnapshot(state);
        if (!ownsEditor()) {
          return;
        }
        try {
          const latestJob = await client.request<CronJob>("cron.get", { id: editedJobId });
          if (!ownsEditor()) {
            return;
          }
          startCronEdit(state, latestJob);
          state.cronError =
            "This automation changed on the Gateway. The latest definition is loaded; review it before retrying.";
        } catch {
          if (ownsEditor()) {
            state.cronError =
              "This automation changed on the Gateway, but the latest definition could not be loaded. Refresh before retrying.";
          }
        }
        return;
      }
      result = { saved: true, jobId: editedJobId };
    } else {
      const response = await client.request("cron.add", job);
      resetCronFormToDefaults(state, agentId);
      result = { saved: true, jobId: extractSavedCronJobId(response) };
    }
    await reloadCronJobsSnapshot(state);
  });
  return result;
}

// Mutations reload the list and scheduler status so both canonical views stay current.
async function reloadCronJobsSnapshot(state: CronState) {
  await loadCronJobsPage(state, { tableFilters: true });
  await loadCronStatus(state);
}

export async function toggleCronJob(
  state: CronState,
  job: CronJob,
  enabled: boolean,
): Promise<boolean> {
  // Report whether the update RPC itself succeeded; the follow-up list reload
  // can be queued or fail without invalidating the confirmed toggle.
  let updated = false;
  await withCronBusy(state, async (client) => {
    const updatedJob = await client.request<CronJob>("cron.update", {
      id: job.id,
      expectedConfigRevision: requireCronConfigRevision(job.configRevision),
      patch: { enabled },
    });
    replaceLocalCronJob(state, updatedJob);
    if (state.cronEditingJob?.id === updatedJob.id) {
      setCronEditState(state, updatedJob, {
        ...state.cronForm,
        enabled: updatedJob.enabled,
      });
    }
    updated = true;
    await reloadCronJobsSnapshot(state);
  });
  return updated;
}

function cronRunNotStartedMessage(result: CronRunResult): string {
  if (!("reason" in result)) {
    return t("cron.runNotStarted.unknown");
  }
  switch (result.reason) {
    case "not-due":
      return t("cron.runNotStarted.notDue");
    case "already-running":
      return t("cron.runNotStarted.alreadyRunning");
    case "restart-recovery-pending":
      return t("cron.runNotStarted.recoveryPending");
    case "invalid-spec":
      return t("cron.runNotStarted.invalidSpec");
    case "stopped":
      return t("cron.runNotStarted.stopped");
  }
  return t("cron.runNotStarted.unknown");
}

export async function runCronJob(state: CronState, jobId: string, mode: "force" | "due" = "force") {
  await withCronBusy(state, async (client) => {
    const result = await client.request<CronRunResult>("cron.run", { id: jobId, mode });
    if (!result.ok || ("ran" in result && !result.ran)) {
      state.cronError = cronRunNotStartedMessage(result);
      // Invalid persisted specs create a skipped history entry with diagnostics;
      // true no-op outcomes have no new history to fetch.
      if ("reason" in result && result.reason === "invalid-spec") {
        await loadCronRuns(state);
      }
      return;
    }
    await loadCronRuns(state);
    if ("enqueued" in result && result.enqueued) {
      state.cronError = `Run queued. Run ID: ${result.runId}`;
    }
  });
}

export async function removeCronJob(state: CronState, job: CronJob) {
  await withCronBusy(state, async (client) => {
    await client.request("cron.remove", { id: job.id });
    const previousLength = state.cronJobs.length;
    state.cronJobs = state.cronJobs.filter((candidate) => candidate.id !== job.id);
    if (state.cronJobs.length !== previousLength) {
      state.cronJobsTotal = Math.max(0, state.cronJobsTotal - 1);
    }
    if (state.cronEditingJob?.id === job.id) {
      clearCronEditState(state);
    }
    if (state.cronRunsJobId === job.id) {
      state.cronRunsJobId = null;
      clearCronRunsPage(state);
    }
    await reloadCronJobsSnapshot(state);
  });
}

export function invalidateCronRefresh(state: CronState) {
  // Retire page reads without canceling an already accepted mutation chain.
  retireCronStatusRequest(state);
  retireCronRunsRequest(state);
  state.cronJobsReloadPending = false;
  state.cronJobsReloadPendingTableFilters = false;
}

function setCronEditState(state: CronState, job: CronJob, form: CronFormState) {
  retireCronSelectedJobRead(state);
  state.cronError = null;
  state.cronEditingJob = job;
  state.cronCloningJob = null;
  state.cronRunsJobId = job.id;
  state.cronForm = form;
  state.cronFieldErrors = validateCronForm(form);
}

export function startCronEdit(state: CronState, job: CronJob) {
  setCronEditState(state, job, jobToForm(job, state.cronForm));
}

function buildCloneName(name: string, existingNames: Set<string>) {
  const base = name.trim() || "Job";
  const first = `${base} copy`;
  if (!existingNames.has(normalizeLowercaseStringOrEmpty(first))) {
    return first;
  }
  let index = 2;
  while (index < 1000) {
    const next = `${base} copy ${index}`;
    if (!existingNames.has(normalizeLowercaseStringOrEmpty(next))) {
      return next;
    }
    index += 1;
  }
  return `${base} copy ${Date.now()}`;
}

export function startCronClone(state: CronState, job: CronJob) {
  clearCronEditState(state);
  state.cronCloningJob = job;
  state.cronRunsJobId = job.id;
  const existingNames = new Set(
    state.cronJobs.map((entry) => normalizeLowercaseStringOrEmpty(entry.name)),
  );
  const cloned = jobToForm(job, state.cronForm);
  cloned.name = buildCloneName(job.name, existingNames);
  if (cloned.payloadLocked) {
    cloned.payloadLocked = false;
    cloned.payloadKind = DEFAULT_CRON_FORM.payloadKind;
    cloned.payloadText = "";
  }
  state.cronForm = normalizeCronFormState(cloned, { payloadKind: cloned.payloadKind });
  state.cronFieldErrors = validateCronForm(state.cronForm);
}

export function cancelCronEdit(state: CronState, agentId: string | null) {
  clearCronEditState(state);
  resetCronFormToDefaults(state, agentId);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
