<<<<<<< HEAD
import type { GatewayBrowserClient } from "../gateway";
import type { CronJob, CronRunLogEntry, CronStatus } from "../types";
import type { CronFormState } from "../ui-types";
import { toNumber } from "../format";
=======
import type { GatewayBrowserClient } from "../gateway.ts";
import type { CronJob, CronRunLogEntry, CronStatus } from "../types.ts";
import type { CronFormState } from "../ui-types.ts";
import { toNumber } from "../format.ts";
>>>>>>> upstream/main

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
};

export async function loadCronStatus(state: CronState) {
<<<<<<< HEAD
  if (!state.client || !state.connected) return;
  try {
    const res = (await state.client.request("cron.status", {})) as CronStatus;
=======
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<CronStatus>("cron.status", {});
>>>>>>> upstream/main
    state.cronStatus = res;
  } catch (err) {
    state.cronError = String(err);
  }
}

export async function loadCronJobs(state: CronState) {
<<<<<<< HEAD
  if (!state.client || !state.connected) return;
  if (state.cronLoading) return;
  state.cronLoading = true;
  state.cronError = null;
  try {
    const res = (await state.client.request("cron.list", {
      includeDisabled: true,
    })) as { jobs?: CronJob[] };
=======
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
>>>>>>> upstream/main
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
<<<<<<< HEAD
    if (!Number.isFinite(ms)) throw new Error("Invalid run time.");
=======
    if (!Number.isFinite(ms)) {
      throw new Error("Invalid run time.");
    }
>>>>>>> upstream/main
    return { kind: "at" as const, atMs: ms };
  }
  if (form.scheduleKind === "every") {
    const amount = toNumber(form.everyAmount, 0);
<<<<<<< HEAD
    if (amount <= 0) throw new Error("Invalid interval amount.");
=======
    if (amount <= 0) {
      throw new Error("Invalid interval amount.");
    }
>>>>>>> upstream/main
    const unit = form.everyUnit;
    const mult = unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
    return { kind: "every" as const, everyMs: amount * mult };
  }
  const expr = form.cronExpr.trim();
<<<<<<< HEAD
  if (!expr) throw new Error("Cron expression required.");
=======
  if (!expr) {
    throw new Error("Cron expression required.");
  }
>>>>>>> upstream/main
  return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined };
}

export function buildCronPayload(form: CronFormState) {
  if (form.payloadKind === "systemEvent") {
    const text = form.payloadText.trim();
<<<<<<< HEAD
    if (!text) throw new Error("System event text required.");
    return { kind: "systemEvent" as const, text };
  }
  const message = form.payloadText.trim();
  if (!message) throw new Error("Agent message required.");
=======
    if (!text) {
      throw new Error("System event text required.");
    }
    return { kind: "systemEvent" as const, text };
  }
  const message = form.payloadText.trim();
  if (!message) {
    throw new Error("Agent message required.");
  }
>>>>>>> upstream/main
  const payload: {
    kind: "agentTurn";
    message: string;
    deliver?: boolean;
    channel?: string;
    to?: string;
    timeoutSeconds?: number;
  } = { kind: "agentTurn", message };
<<<<<<< HEAD
  if (form.deliver) payload.deliver = true;
  if (form.channel) payload.channel = form.channel;
  if (form.to.trim()) payload.to = form.to.trim();
  const timeoutSeconds = toNumber(form.timeoutSeconds, 0);
  if (timeoutSeconds > 0) payload.timeoutSeconds = timeoutSeconds;
=======
  if (form.deliver) {
    payload.deliver = true;
  }
  if (form.channel) {
    payload.channel = form.channel;
  }
  if (form.to.trim()) {
    payload.to = form.to.trim();
  }
  const timeoutSeconds = toNumber(form.timeoutSeconds, 0);
  if (timeoutSeconds > 0) {
    payload.timeoutSeconds = timeoutSeconds;
  }
>>>>>>> upstream/main
  return payload;
}

export async function addCronJob(state: CronState) {
<<<<<<< HEAD
  if (!state.client || !state.connected || state.cronBusy) return;
=======
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
>>>>>>> upstream/main
  state.cronBusy = true;
  state.cronError = null;
  try {
    const schedule = buildCronSchedule(state.cronForm);
    const payload = buildCronPayload(state.cronForm);
    const agentId = state.cronForm.agentId.trim();
    const job = {
      name: state.cronForm.name.trim(),
      description: state.cronForm.description.trim() || undefined,
      agentId: agentId || undefined,
      enabled: state.cronForm.enabled,
      schedule,
      sessionTarget: state.cronForm.sessionTarget,
      wakeMode: state.cronForm.wakeMode,
      payload,
      isolation:
        state.cronForm.postToMainPrefix.trim() && state.cronForm.sessionTarget === "isolated"
          ? { postToMainPrefix: state.cronForm.postToMainPrefix.trim() }
          : undefined,
    };
<<<<<<< HEAD
    if (!job.name) throw new Error("Name required.");
=======
    if (!job.name) {
      throw new Error("Name required.");
    }
>>>>>>> upstream/main
    await state.client.request("cron.add", job);
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

export async function toggleCronJob(state: CronState, job: CronJob, enabled: boolean) {
<<<<<<< HEAD
  if (!state.client || !state.connected || state.cronBusy) return;
=======
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
>>>>>>> upstream/main
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
<<<<<<< HEAD
  if (!state.client || !state.connected || state.cronBusy) return;
=======
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
>>>>>>> upstream/main
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
<<<<<<< HEAD
  if (!state.client || !state.connected || state.cronBusy) return;
=======
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
>>>>>>> upstream/main
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
<<<<<<< HEAD
  if (!state.client || !state.connected) return;
  try {
    const res = (await state.client.request("cron.runs", {
      id: jobId,
      limit: 50,
    })) as { entries?: CronRunLogEntry[] };
=======
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<{ entries?: Array<CronRunLogEntry> }>("cron.runs", {
      id: jobId,
      limit: 50,
    });
>>>>>>> upstream/main
    state.cronRunsJobId = jobId;
    state.cronRuns = Array.isArray(res.entries) ? res.entries : [];
  } catch (err) {
    state.cronError = String(err);
  }
}
