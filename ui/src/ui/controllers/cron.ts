import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { CronJob, CronRunLogEntry, CronStatus } from "../types.ts";
import type { CronFormState } from "../ui-types.ts";

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
  cronBusy: boolean;
  cronEditingId?: string | null;
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
    if (state.cronEditingId) {
      // Update existing job
      await state.client.request("cron.update", { id: state.cronEditingId, patch: job });
      // clear editing state
      state.cronEditingId = null;
    } else {
      await state.client.request("cron.add", job);
    }
    state.cronForm = {
      ...state.cronForm,
      name: "",
      description: "",
      payloadText: "",
    };
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export function openEditCron(state: CronState, job: CronJob) {
  // Map job fields into the form state
  const form: CronFormState = {
    name: job.name || "",
    description: job.description || "",
    agentId: job.agentId || "",
    enabled: typeof job.enabled === "boolean" ? job.enabled : true,
    scheduleKind:
      job.schedule.kind === "at" ? "at" : job.schedule.kind === "every" ? "every" : "cron",
    scheduleAt:
      job.schedule.kind === "at" &&
      typeof (job.schedule as unknown as { at?: string }).at === "string"
        ? (job.schedule as unknown as { at: string }).at
        : "",
    everyAmount:
      job.schedule.kind === "every" &&
      typeof (job.schedule as unknown as { everyMs?: number }).everyMs === "number"
        ? String(Math.floor((job.schedule as unknown as { everyMs: number }).everyMs / 60000))
        : "",
    everyUnit: job.schedule.kind === "every" ? "minutes" : "minutes",
    cronExpr:
      job.schedule.kind === "cron" &&
      typeof (job.schedule as unknown as { expr?: string }).expr === "string"
        ? (job.schedule as unknown as { expr: string }).expr
        : "",
    cronTz:
      job.schedule.kind === "cron" &&
      typeof (job.schedule as unknown as { tz?: string }).tz === "string"
        ? (job.schedule as unknown as { tz: string }).tz
        : "",
    sessionTarget: job.sessionTarget || "main",
    wakeMode: job.wakeMode || "now",
    payloadKind: job.payload.kind === "systemEvent" ? "systemEvent" : "agentTurn",
    payloadText: job.payload.kind === "systemEvent" ? job.payload.text : job.payload.message,
    deliveryMode: job.delivery ? job.delivery.mode : "none",
    deliveryChannel: job.delivery?.channel || "",
    deliveryTo: job.delivery?.to || "",
    timeoutSeconds:
      job.payload.kind === "agentTurn" && job.payload.timeoutSeconds
        ? String(job.payload.timeoutSeconds)
        : "",
  };
  state.cronForm = form;
  state.cronEditingId = job.id;
}

export function cancelEditCron(state: CronState) {
  state.cronEditingId = null;
  state.cronForm = {
    ...state.cronForm,
    name: "",
    description: "",
    payloadText: "",
  };
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
    await loadCronRuns(state, job.id);
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
