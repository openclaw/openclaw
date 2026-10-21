import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { CronAddResult } from "../../../../packages/gateway-protocol/src/schema/cron.types.js";
import { resolveCronTriggerMinIntervalMs } from "../../../../src/config/cron-limits.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob, CronRunResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import { toNumber } from "../format.ts";
import { parseCronDurationMs } from "./decimal.ts";
import {
  hasUnchangedCronSchedule,
  buildCronSchedule,
  parseCronScheduleAt,
} from "./form-schedule.ts";
import { isReadOnlyCronPayload, jobToForm, normalizeCronFormState } from "./form.ts";
import { loadCronJobsPage } from "./jobs-full.ts";
import { retireCronJobsRequest } from "./jobs.ts";
import { buildCronPayload } from "./payload.ts";
import { cronRunNotStartedMessage } from "./run-feedback.ts";
import { clearCronRunsPage, loadCronRuns, retireCronRunsRequest } from "./runs.ts";
import {
  DEFAULT_CRON_FORM,
  loadCronStatus,
  retireCronSelectedJobRead,
  retireCronStatusFeedback,
  retireCronStatusRequest,
} from "./state.ts";
import type { CronFieldErrors, CronFormState, CronState } from "./types.ts";
import { resolveCronWebhookDeliveryError } from "./webhook-url.ts";

export { normalizeCronFormState } from "./form.ts";
export { createInitialCronState, loadCronStatus } from "./state.ts";
export { loadCronScopeStats } from "./scope.ts";
export { loadCronJobsPage } from "./jobs-full.ts";
export { resolveConfiguredCronModelSuggestions } from "./model-suggestions.ts";

const CRON_CHANNEL_LAST = "last";

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
    if (!safeParseJsonRecord(form.eventArguments)) {
      errors.eventArguments = "cron.events.eventArgumentsInvalid";
    }
  } else if (form.scheduleKind === "at") {
    if (!parseCronScheduleAt(form.scheduleAt)) {
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
  if (form.activeHoursEnabled) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.activeHoursStart)) {
      errors.activeHoursStart = "cron.errors.activeHoursTime";
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.activeHoursEnd) && form.activeHoursEnd !== "24:00") {
      errors.activeHoursEnd = "cron.errors.activeHoursTime";
    }
    const timezone = form.activeHoursTimezone.trim();
    if (timezone && timezone !== "local" && timezone !== "user") {
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
      } catch {
        errors.activeHoursTimezone = "cron.errors.activeHoursTimezone";
      }
    }
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

const activeCronMutations = new WeakMap<CronState, object>();

async function withCronBusy(
  state: CronState,
  job: Pick<CronJob, "id" | "name" | "displayName"> | undefined,
  run: (
    client: GatewayBrowserClient,
    reportFeedback: (message: string) => void,
    isCurrent: () => boolean,
  ) => Promise<void>,
) {
  const client = state.client;
  if (!client || !state.connected || state.cronBusy) {
    return;
  }
  const target = job ? { id: job.id, name: job.displayName ?? job.name } : null;
  const operation = {};
  activeCronMutations.set(state, operation);
  const isCurrent = () => activeCronMutations.get(state) === operation;
  const reportFeedback = (message: string) => {
    if (!isCurrent()) {
      return;
    }
    state.cronError =
      target && state.cronEditingJob?.id !== target.id ? `${target.name}: ${message}` : message;
  };
  retireCronStatusFeedback(state);
  state.cronBusy = true;
  state.cronError = null;
  try {
    await run(client, reportFeedback, isCurrent);
  } catch (err) {
    reportFeedback(formatUiError(err));
  } finally {
    if (isCurrent()) {
      activeCronMutations.delete(state);
      retireCronStatusFeedback(state);
      state.cronBusy = false;
    }
  }
}

function requireCronConfigRevision(revision: string | null | undefined): string {
  if (revision) {
    return revision;
  }
  throw new Error("This automation is missing its configuration revision. Refresh and try again.");
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
  if (patch.cronJobsQuery !== undefined) {
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

type CronSaveResult = { saved: false } | { saved: true; jobId: string };

export async function addCronJob(state: CronState): Promise<CronSaveResult> {
  let result: CronSaveResult = { saved: false };
  await withCronBusy(state, undefined, async (client, _reportFeedback, isCurrent) => {
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
    const sourceJob = editingJob ?? state.cronCloningJob;
    const sourcePayload = sourceJob?.payload ?? null;
    // Form fields cannot represent process commands, anchors, or full timestamp precision.
    const schedule =
      sourceJob && hasUnchangedCronSchedule(form, sourceJob)
        ? editingJob
          ? undefined
          : sourceJob.schedule
        : buildCronSchedule(form, editingJob?.schedule);
    const preserveLockedPayload = Boolean(
      editingJob && form.payloadLocked && isReadOnlyCronPayload(sourcePayload),
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
    const ownerTarget = selectedDeliveryMode === "announce" && form.deliveryTarget === "owner";
    const previousDelivery =
      editingJob?.delivery?.mode === "webhook" ? undefined : editingJob?.delivery;
    // Owner lookup may be account-scoped, but must never inherit a conversation or thread target.
    const ownerChannel =
      form.deliveryChannel !== "last" ? form.deliveryChannel.trim() || undefined : undefined;
    const delivery = selectedDeliveryMode
      ? {
          mode: selectedDeliveryMode,
          ...(selectedDeliveryMode === "none"
            ? {
                ...(form.deliveryBestEffort ? { bestEffort: true } : {}),
                ...(form.deliveryTarget === "owner"
                  ? {
                      target: "owner",
                      channel: ownerChannel,
                      accountId: normalizedDeliveryAccountId || undefined,
                    }
                  : {}),
                ...(form.deliveryDirectPolicy ? { directPolicy: form.deliveryDirectPolicy } : {}),
              }
            : {
                channel: ownerTarget
                  ? (ownerChannel ??
                    (editingJob?.delivery?.channel !== undefined ? null : undefined))
                  : selectedDeliveryMode === "announce"
                    ? normalizePersistedDeliveryChannel(form.deliveryChannel, {
                        preserveLast: Boolean(editingJob?.delivery?.channel),
                      })
                    : undefined,
                to:
                  (ownerTarget ? "" : form.deliveryTo.trim()) ||
                  (selectedDeliveryMode === "announce" && editingJob?.delivery?.to
                    ? null
                    : undefined),
                target: ownerTarget ? "owner" : previousDelivery?.target ? null : undefined,
                directPolicy:
                  selectedDeliveryMode === "announce"
                    ? form.deliveryDirectPolicy ||
                      (previousDelivery?.directPolicy ? null : undefined)
                    : undefined,
                accountId: deliveryAccountId,
                bestEffort: form.deliveryBestEffort,
              }),
          threadId:
            (!ownerTarget ? form.deliveryThreadId : undefined) ??
            (editingJob?.delivery?.threadId !== undefined ? null : undefined),
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
      activeHours: form.activeHoursEnabled
        ? {
            start: form.activeHoursStart,
            end: form.activeHoursEnd,
            ...(form.activeHoursTimezone.trim()
              ? { timezone: form.activeHoursTimezone.trim() }
              : {}),
          }
        : editingJob?.activeHours
          ? null
          : undefined,
      idleOnly: form.idleOnly || editingJob?.idleOnly !== undefined ? form.idleOnly : undefined,
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
      if (!(await updateCronJobDefinition(state, client, editingJob, job, "save", isCurrent))) {
        return;
      }
      result = { saved: true, jobId: editingJob.id };
    } else {
      let response: CronAddResult;
      try {
        response = await client.request<CronAddResult>("cron.add", job);
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        if (state.cronForm === form && state.cronEditingJob === editingJob) {
          throw error;
        }
        return;
      }
      if (!isCurrent()) {
        return;
      }
      if (state.cronForm === form && state.cronEditingJob === editingJob) {
        resetCronFormToDefaults(state, agentId);
        state.cronCreateOpen = false;
      }
      result = { saved: true, jobId: ("job" in response ? response.job : response).id };
    }
    await reloadCronJobsSnapshot(state);
    if (!isCurrent()) {
      result = { saved: false };
    }
  });
  return result;
}

async function updateCronJobDefinition(
  state: CronState,
  client: GatewayBrowserClient,
  job: CronJob,
  patch: Record<string, unknown>,
  operation: "save" | "toggle",
  isCurrent: () => boolean,
): Promise<boolean> {
  const form = state.cronForm;
  const selectedJob = state.cronEditingJob;
  const ownsEditor = () => state.cronEditingJob === job && state.cronForm === form;
  try {
    const updatedJob = await client.request<CronJob>("cron.update", {
      id: job.id,
      expectedConfigRevision: requireCronConfigRevision(job.configRevision),
      patch,
    });
    if (!isCurrent()) {
      return false;
    }
    state.cronJobs = state.cronJobs.map((entry) =>
      entry.id === updatedJob.id ? updatedJob : entry,
    );
    if (ownsEditor()) {
      if (operation === "toggle") {
        setCronEditState(state, updatedJob, { ...form, enabled: updatedJob.enabled });
      } else {
        startCronEdit(state, updatedJob);
      }
    }
    return true;
  } catch (error) {
    if (!isCurrent()) {
      return false;
    }
    const details = isRecord(error) && isRecord(error.details) ? error.details : null;
    if (details?.code !== "CRON_JOB_CHANGED" || selectedJob !== job) {
      if (operation === "toggle" || ownsEditor()) {
        throw error;
      }
      return false;
    }
    await reloadCronJobsSnapshot(state);
    if (!isCurrent() || !ownsEditor()) {
      return false;
    }
    try {
      const latestJob = await client.request<CronJob>("cron.get", { id: job.id });
      if (isCurrent() && ownsEditor()) {
        startCronEdit(state, latestJob);
        state.cronError =
          "This automation changed on the Gateway. The latest definition is loaded; review it before retrying.";
      }
    } catch {
      if (isCurrent() && ownsEditor()) {
        state.cronError =
          "This automation changed on the Gateway, but the latest definition could not be loaded. Refresh before retrying.";
      }
    }
    return false;
  }
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
  await withCronBusy(state, job, async (client, _reportFeedback, isCurrent) => {
    updated = await updateCronJobDefinition(state, client, job, { enabled }, "toggle", isCurrent);
    if (updated) {
      await reloadCronJobsSnapshot(state);
    }
  });
  return updated;
}

export async function runCronJob(state: CronState, jobId: string, mode: "force" | "due" = "force") {
  const job =
    state.cronEditingJob?.id === jobId
      ? state.cronEditingJob
      : (state.cronJobs.find((candidate) => candidate.id === jobId) ?? { id: jobId, name: jobId });
  await withCronBusy(state, job, async (client, reportFeedback, isCurrent) => {
    const result = await client.request<CronRunResult>("cron.run", { id: jobId, mode });
    if (!isCurrent()) {
      return;
    }
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
  await withCronBusy(state, job, async (client, _reportFeedback, isCurrent) => {
    await client.request("cron.remove", { id: job.id });
    if (!isCurrent()) {
      return;
    }
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
  retireCronJobsRequest(state);
  state.cronJobsReloadPending = false;
  state.cronJobsReloadPendingTableFilters = false;
}

export function invalidateCronMutation(state: CronState) {
  // Already-dispatched writes may finish, but retired replies cannot change a retained draft.
  activeCronMutations.delete(state);
  state.cronBusy = false;
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
