import type { OpenClawApp } from "./app.ts";
import { normalizeCronFormState } from "./controllers/cron.ts";

const QUEUE_PREFIX = "queue:";

function makeQueueJobName(agentId: string, task: string) {
  const summary = task.trim().replace(/\s+/g, " ").slice(0, 60);
  return `${QUEUE_PREFIX}${agentId}: ${summary}`;
}

export async function queueAgentTask(host: OpenClawApp, agentId: string, task: string) {
  if (!host.connected || !host.client) {
    host.lastError = "Not connected.";
    return;
  }
  const trimmedTask = task.trim();
  if (!trimmedTask) {
    return;
  }

  // One-shot: schedule a few seconds from now so it behaves like an enqueue.
  const at = new Date(Date.now() + 3000).toISOString();

  try {
    host.cronError = null;
    host.cronBusy = true;

    const form = normalizeCronFormState({
      ...host.cronForm,
      name: makeQueueJobName(agentId, trimmedTask),
      description: "Queued via Agents runner",
      agentId,
      enabled: true,
      scheduleKind: "at",
      scheduleAt: at,
      sessionTarget: "isolated",
      wakeMode: "now",
      payloadKind: "agentTurn",
      payloadText: trimmedTask,
      deliveryMode: "none",
      deliveryChannel: "last",
      deliveryTo: "",
    });

    // Reuse the same build/add logic as cron controller expects by calling RPC directly.
    await host.client.request("cron.add", {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      agentId: form.agentId.trim() || undefined,
      enabled: true,
      schedule: { kind: "at", at },
      sessionTarget: "isolated",
      wakeMode: form.wakeMode,
      payload: {
        kind: "agentTurn",
        message: form.payloadText.trim(),
        timeoutSeconds: form.timeoutSeconds ? Number(form.timeoutSeconds) : undefined,
      },
      delivery: { mode: "none" },
    });

    await host.loadCron();
    await host.loadSessions();
  } catch (err) {
    host.cronError = String(err);
  } finally {
    host.cronBusy = false;
  }
}
