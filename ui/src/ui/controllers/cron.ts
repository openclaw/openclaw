import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { CronJob, CronRunLogEntry, CronStatus, OpsRuntimeRunsResult } from "../types.ts";
import type { CronFormState, CronRuntimeRunsFilters } from "../ui-types.ts";

export type CronState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronLoading: boolean;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  cronError: string | null;
  cronForm: CronFormState;
  cronRunsJobId: string | null;
  cronRuns: CronRunLogEntry[];
  cronRuntimeRunsLoading: boolean;
  cronRuntimeRunsError: string | null;
  cronRuntimeRunsFilters: CronRuntimeRunsFilters;
  cronRuntimeRuns: OpsRuntimeRunsResult | null;
  cronBusy: boolean;
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

export async function loadCronJobs(state: CronState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.cronLoading) {
    return;
  }
  state.cronLoading = true;
  state.cronError = null;
  try {
    const res = await state.client.request<{ jobs?: Array<CronJob> }>("cron.list", {
      includeDisabled: true,
    });
    state.cronJobs = Array.isArray(res.jobs) ? res.jobs : [];
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronLoading = false;
  }
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
  return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined };
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
    timeoutSeconds?: number;
  } = { kind: "agentTurn", message };
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
          }
        : undefined;
    const agentId = form.agentId.trim();
    const job = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      agentId: agentId || undefined,
      enabled: form.enabled,
      schedule,
      sessionTarget: form.sessionTarget,
      wakeMode: form.wakeMode,
      payload,
      delivery,
    };
    if (!job.name) {
      throw new Error("Name required.");
    }
    await state.client.request("cron.add", job);
    state.cronForm = {
      ...state.cronForm,
      name: "",
      description: "",
      payloadText: "",
    };
    await loadCronJobs(state);
    await loadCronStatus(state);
    await loadOpsRuntimeRuns(state);
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
    await loadOpsRuntimeRuns(state);
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
    await loadCronRuns(state, job.id);
    await loadOpsRuntimeRuns(state);
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
    if (state.cronRunsJobId === job.id) {
      state.cronRunsJobId = null;
      state.cronRuns = [];
    }
    await loadCronJobs(state);
    await loadCronStatus(state);
    await loadOpsRuntimeRuns(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function loadCronRuns(state: CronState, jobId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<{ entries?: Array<CronRunLogEntry> }>("cron.runs", {
      id: jobId,
      limit: 50,
    });
    state.cronRunsJobId = jobId;
    state.cronRuns = Array.isArray(res.entries) ? res.entries : [];
  } catch (err) {
    state.cronError = String(err);
  }
}

const DEFAULT_RUNTIME_RUNS_SUMMARY = {
  jobsScanned: 0,
  jobsTotal: 0,
  jobsTruncated: false,
  totalRuns: 0,
  okRuns: 0,
  errorRuns: 0,
  skippedRuns: 0,
  timeoutRuns: 0,
  jobsWithFailures: 0,
  needsAction: 0,
};

export function applyCronRuntimeRunsPreset(
  state: Pick<CronState, "cronRuntimeRunsFilters">,
  preset: "1h" | "6h" | "24h" | "7d" | "clear",
) {
  if (preset === "clear") {
    state.cronRuntimeRunsFilters = {
      ...state.cronRuntimeRunsFilters,
      fromLocal: "",
      toLocal: "",
    };
    return;
  }
  const now = Date.now();
  const minutes =
    preset === "1h" ? 60 : preset === "6h" ? 360 : preset === "24h" ? 24 * 60 : 7 * 24 * 60;
  const fromMs = now - minutes * 60_000;
  state.cronRuntimeRunsFilters = {
    ...state.cronRuntimeRunsFilters,
    fromLocal: formatDateTimeLocalInput(fromMs),
    toLocal: formatDateTimeLocalInput(now),
  };
}

export async function loadOpsRuntimeRuns(state: CronState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.cronRuntimeRunsLoading) {
    return;
  }

  const paramsResult = buildOpsRuntimeRunsParams(state.cronRuntimeRunsFilters);
  if (!paramsResult.ok) {
    state.cronRuntimeRunsError = paramsResult.error;
    return;
  }

  state.cronRuntimeRunsLoading = true;
  state.cronRuntimeRunsError = null;
  try {
    const res = await state.client.request<OpsRuntimeRunsResult>(
      "ops.runtime.runs",
      paramsResult.params,
    );
    state.cronRuntimeRuns = normalizeOpsRuntimeRunsResult(res);
  } catch (err) {
    state.cronRuntimeRunsError = resolveOpsRuntimeRunsError(err);
  } finally {
    state.cronRuntimeRunsLoading = false;
  }
}

function buildOpsRuntimeRunsParams(
  filters: CronRuntimeRunsFilters,
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const fromMs = parseDateTimeLocalInput(filters.fromLocal);
  if (filters.fromLocal.trim() && fromMs == null) {
    return { ok: false, error: 'Invalid "From" time. Use a valid date/time.' };
  }
  const toMs = parseDateTimeLocalInput(filters.toLocal);
  if (filters.toLocal.trim() && toMs == null) {
    return { ok: false, error: 'Invalid "To" time. Use a valid date/time.' };
  }
  if (fromMs != null && toMs != null && fromMs > toMs) {
    return { ok: false, error: '"From" time cannot be later than "To" time.' };
  }

  const limit = Math.max(1, Math.min(500, toNumber(filters.limit, 100)));
  const search = filters.search.trim();
  const status = filters.status === "all" ? undefined : filters.status;

  return {
    ok: true,
    params: {
      limit,
      perJobLimit: 120,
      search: search || undefined,
      status,
      fromMs,
      toMs,
      includeDisabledCron: filters.includeDisabledCron,
    },
  };
}

function normalizeOpsRuntimeRunsResult(
  input: OpsRuntimeRunsResult | null | undefined,
): OpsRuntimeRunsResult {
  const summary =
    input && typeof input.summary === "object" && input.summary
      ? {
          jobsScanned: toNumber(String(input.summary.jobsScanned ?? 0), 0),
          jobsTotal: toNumber(String(input.summary.jobsTotal ?? 0), 0),
          jobsTruncated: Boolean(input.summary.jobsTruncated),
          totalRuns: toNumber(String(input.summary.totalRuns ?? 0), 0),
          okRuns: toNumber(String(input.summary.okRuns ?? 0), 0),
          errorRuns: toNumber(String(input.summary.errorRuns ?? 0), 0),
          skippedRuns: toNumber(String(input.summary.skippedRuns ?? 0), 0),
          timeoutRuns: toNumber(String(input.summary.timeoutRuns ?? 0), 0),
          jobsWithFailures: toNumber(String(input.summary.jobsWithFailures ?? 0), 0),
          needsAction: toNumber(String(input.summary.needsAction ?? 0), 0),
        }
      : DEFAULT_RUNTIME_RUNS_SUMMARY;
  return {
    ts: typeof input?.ts === "number" ? input.ts : Date.now(),
    summary,
    runs: Array.isArray(input?.runs) ? input.runs : [],
    failures: Array.isArray(input?.failures) ? input.failures : [],
  };
}

function resolveOpsRuntimeRunsError(error: unknown): string {
  const text = String(error);
  const normalized = text.toLowerCase();
  if (
    normalized.includes("unknown method") ||
    normalized.includes("method not found") ||
    normalized.includes("ops.runtime.runs")
  ) {
    return "Gateway version does not expose ops.runtime.runs yet.";
  }
  return text;
}

function parseDateTimeLocalInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDateTimeLocalInput(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}
