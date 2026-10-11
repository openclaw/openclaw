import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  readNonEmptyStringPreservingWhitespace,
} from "@openclaw/normalization-core/string-coerce";
import { resolveCronTriggerMinIntervalMs } from "../../../../src/config/cron-limits.js";
import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob, CronRunResult, CronStatus, CronPayload } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import { toNumber } from "../format.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";
import { parseCronDurationMs } from "./decimal.ts";
import { hasUnchangedCronSchedule, buildCronSchedule } from "./form-schedule.ts";
import {
  DEFAULT_CRON_FORM,
  isReadOnlyCronPayload,
  jobToForm,
  normalizeCronFormState,
} from "./form.ts";
import { loadCronJobsPage } from "./jobs.ts";
import { getCronJobPayload } from "./payload.ts";
import { cronRunNotStartedMessage } from "./run-feedback.ts";
import { clearCronRunsPage, loadCronRuns, retireCronRunsRequest } from "./runs.ts";
import type { CronFieldErrors, CronFormState, CronState } from "./types.ts";
import { resolveCronWebhookDeliveryError } from "./webhook-url.ts";

export { normalizeCronFormState } from "./form.ts";
export { loadCronScopeStats } from "./scope.ts";
export { loadCronJobsPage } from "./jobs.ts";
export { getCronJobPayload } from "./payload.ts";
export { resolveConfiguredCronModelSuggestions } from "./model-suggestions.ts";

const CRON_CHANNEL_LAST = "last";

export function createInitialCronState<Row = CronJob>(
  snapshot: Partial<Pick<CronState, "client" | "connected">> = {},
): CronState<Row> {
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

export function validateCronForm(form: CronFormState): CronFieldErrors {
  const errors: CronFieldErrors = {};
  if (!form.name.trim()) {
    errors.name = "cron.errors.nameRequired";
  }
  if (form.scheduleKind === "event" && form.payloadKind !== "agentTurn") {
    errors.payloadText = "cron.events.agentTurnRequired";
  }
  if (form.scheduleKind === "event" && form.eventSource === "mcp-events") {
    if (!form.eventServer.trim()) {
      errors.eventServer = "cron.events.eventServerRequired";
    }
    if (!form.eventName.trim()) {
      errors.eventName = "cron.events.eventNameRequired";
    }
    try {
      if (!isRecord(JSON.parse(form.eventArguments))) {
        errors.eventArguments = "cron.events.eventArgumentsInvalid";
      }
    } catch {
      errors.eventArguments = "cron.events.eventArgumentsInvalid";
    }
  } else if (form.scheduleKind === "at") {
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
  if (!form.deliveryMode) {
    errors.deliveryMode = "cron.errors.deliveryModeRequired";
  }
  if (form.deliveryMode === "webhook") {
    const error = resolveCronWebhookDeliveryError(form.deliveryTo);
    if (error) {
      errors.deliveryTo = error;
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

type CronStatusState = Pick<
  CronState,
  | "client"
  | "connected"
  | "canRefresh"
  | "cronAgentId"
  | "cronEditingJob"
  | "cronStatus"
  | "cronError"
  | "cronBusy"
>;

type CronStatusRequest = {
  client: GatewayBrowserClient;
  selectedJob: CronJob | null;
  reportErrors: boolean;
  queued?: Deferred;
};
const activeCronStatusRequests = new WeakMap<CronStatusState, CronStatusRequest>();

function retireCronStatusRequest(state: CronStatusState) {
  activeCronStatusRequests.get(state)?.queued?.resolve();
  activeCronStatusRequests.delete(state);
}

function retireCronStatusFeedback(state: CronStatusState) {
  const request = activeCronStatusRequests.get(state);
  if (request) {
    request.reportErrors = false;
  }
}

export async function loadCronStatus(
  state: CronStatusState,
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

async function withCronBusy(
  state: CronState,
  job: Pick<CronJob, "id" | "name" | "displayName"> | undefined,
  run: (client: GatewayBrowserClient, reportFeedback: (message: string) => void) => Promise<void>,
) {
  const client = state.client;
  if (!client || !state.connected || state.cronBusy) {
    return;
  }
  const target = job ? { id: job.id, name: job.displayName ?? job.name } : null;
  const reportFeedback = (message: string) => {
    state.cronError =
      target && state.cronEditingJob?.id !== target.id ? `${target.name}: ${message}` : message;
  };
  retireCronStatusFeedback(state);
  state.cronBusy = true;
  state.cronError = null;
  try {
    await run(client, reportFeedback);
  } catch (err) {
    reportFeedback(formatUiError(err));
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
  if (!channel || (channel === CRON_CHANNEL_LAST && !options.preserveLast)) {
    return undefined;
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
  const record = asNullableObjectRecord(response);
  const container = record && "job" in record ? asNullableObjectRecord(record.job) : record;
  return readNonEmptyStringPreservingWhitespace(container?.id) ?? null;
}

export async function addCronJob(state: CronState): Promise<CronSaveResult> {
  let result: CronSaveResult = { saved: false };
  await withCronBusy(state, undefined, async (client) => {
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
        : buildCronSchedule(form, editingJob?.schedule);
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
    const delivery = selectedDeliveryMode
      ? {
          mode: selectedDeliveryMode,
          ...(selectedDeliveryMode === "none"
            ? form.deliveryBestEffort
              ? { bestEffort: true }
              : {}
            : {
                channel:
                  selectedDeliveryMode === "announce"
                    ? normalizePersistedDeliveryChannel(form.deliveryChannel, {
                        preserveLast: Boolean(editingJob?.delivery?.channel),
                      })
                    : undefined,
                to:
                  form.deliveryTo.trim() ||
                  (selectedDeliveryMode === "announce" && editingJob?.delivery?.to
                    ? null
                    : undefined),
                accountId: deliveryAccountId,
                bestEffort: form.deliveryBestEffort,
              }),
          ...(form.deliveryThreadId !== undefined ? { threadId: form.deliveryThreadId } : {}),
          ...(selectedDeliveryMode === "announce" && form.deliveryCompletionDestination
            ? { completionDestination: form.deliveryCompletionDestination }
            : {}),
          ...(form.deliveryFailureDestination
            ? { failureDestination: form.deliveryFailureDestination }
            : {}),
        }
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
  await withCronBusy(state, job, async (client) => {
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

export async function runCronJob(state: CronState, jobId: string, mode: "force" | "due" = "force") {
  const job =
    state.cronEditingJob?.id === jobId
      ? state.cronEditingJob
      : (state.cronJobs.find((candidate) => candidate.id === jobId) ?? { id: jobId, name: jobId });
  await withCronBusy(state, job, async (client, reportFeedback) => {
    const result = await client.request<CronRunResult>("cron.run", { id: jobId, mode });
    if (!result.ok || ("ran" in result && !result.ran)) {
      reportFeedback(cronRunNotStartedMessage(result));
      // Invalid persisted specs create a skipped history entry with diagnostics;
      // true no-op outcomes have no new history to fetch.
      if ("reason" in result && result.reason === "invalid-spec") {
        await loadCronRuns(state);
      }
      return;
    }
    await loadCronRuns(state);
    if ("enqueued" in result && result.enqueued) {
      reportFeedback(`Run queued. Run ID: ${result.runId}`);
    }
  });
}

export async function removeCronJob(state: CronState, job: CronJob) {
  await withCronBusy(state, job, async (client) => {
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
  for (let index = 1; index < 1000; index += 1) {
    const next = index === 1 ? `${base} copy` : `${base} copy ${index}`;
    if (!existingNames.has(normalizeLowercaseStringOrEmpty(next))) {
      return next;
    }
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
