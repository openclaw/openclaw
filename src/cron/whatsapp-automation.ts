import { getChannelPlugin } from "../channels/plugins/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronServiceContract } from "./service-contract.js";
import type { CronJob, CronSchedule } from "./types.js";

export type WhatsAppAutomationPeer = Readonly<{ accountId: string; peer: string }>;
type TimeSchedule = Extract<CronSchedule, { kind: "at" | "cron" | "every" }>;

export type WhatsAppAutomationRequest =
  | { action: "list" }
  | { action: "add"; text: string; schedule: TimeSchedule; mode?: "reminder" | "task" }
  | { action: "update"; id: string; text?: string; schedule?: TimeSchedule; enabled?: boolean }
  | { action: "remove"; id: string };

export async function hasWhatsAppAutomationPermission(
  cfg: OpenClawConfig,
  owner: WhatsAppAutomationPeer,
) {
  const plugin = getChannelPlugin("whatsapp");
  if (
    cfg.session?.dmScope !== "per-account-channel-peer" ||
    !plugin?.config.listAccountIds(cfg).includes(owner.accountId)
  ) {
    return false;
  }
  const account = plugin.config.resolveAccount(cfg, owner.accountId);
  if (plugin.config.isEnabled?.(account, cfg) === false) {
    return false;
  }
  return (
    (await plugin.security?.isDirectSenderAdmitted?.({
      cfg,
      account,
      accountId: owner.accountId,
      senderId: owner.peer,
    })) === true
  );
}

export async function manageWhatsAppAutomations(
  cron: CronServiceContract,
  owner: WhatsAppAutomationPeer & { agentId: string; sessionKey: string; assertCurrent(): void },
  request: WhatsAppAutomationRequest,
  task?: { sessionId: string; tools: { name: string; pluginId?: string }[] },
) {
  const owns = (job: CronJob) =>
    job.agentId === owner.agentId &&
    job.payload.kind === "whatsappAutomation" &&
    job.payload.accountId === owner.accountId &&
    job.payload.peer === owner.peer;
  const view = (job: CronJob) => ({
    id: job.id,
    text: job.name,
    mode: job.payload.kind === "whatsappAutomation" && job.payload.task ? "task" : "reminder",
    schedule: job.schedule,
    enabled: job.enabled,
    nextRunAtMs: job.state.nextRunAtMs,
  });
  owner.assertCurrent();
  if (request.action === "list") {
    const jobs = await cron.list({ includeDisabled: true });
    owner.assertCurrent();
    return { jobs: jobs.filter(owns).map(view) };
  }
  if (request.action === "add") {
    if (request.mode === "task" && !task) {
      throw new Error("This turn could not capture its executable tools.");
    }
    const saved = await cron.add(
      {
        agentId: owner.agentId,
        sessionKey: owner.sessionKey,
        name: request.text,
        enabled: true,
        schedule: request.schedule,
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        delivery: { mode: "none" },
        failureAlert: false,
        payload: {
          kind: "whatsappAutomation",
          accountId: owner.accountId,
          peer: owner.peer,
          ...(request.mode === "task" ? { task } : {}),
        },
      },
      { commitGuard: owner.assertCurrent },
    );
    return view(saved);
  }
  const assertOwned = (job: CronJob | undefined) => {
    owner.assertCurrent();
    if (!job || !owns(job)) {
      throw new Error("Schedule not found.");
    }
  };
  const job = await cron.readJob(request.id);
  if (!job) {
    throw new Error("Schedule not found.");
  }
  assertOwned(job);
  if (request.action === "remove") {
    const { resolveCronJobConfigRevision } = await import("./config-revision.js");
    return await cron.remove(request.id, {
      commitGuard: owner.assertCurrent,
      expectedConfigRevision: resolveCronJobConfigRevision(job),
    });
  }
  return view(
    await cron.updateWithPrecondition(
      request.id,
      {
        ...(request.text === undefined ? {} : { name: request.text }),
        ...(request.schedule === undefined ? {} : { schedule: request.schedule }),
        ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
      },
      assertOwned,
      { commitGuard: owner.assertCurrent },
    ),
  );
}
