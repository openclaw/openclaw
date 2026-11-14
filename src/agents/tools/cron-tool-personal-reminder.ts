import type { PersonalReminderOrigin } from "../../gateway/cron-creator-authority-grant.js";
import { isRecord } from "../../utils.js";

/** Keep caller-owned schedules on the admitted human route; ordinary capture caps tools. */
export function applyPersonalReminderDefaults(
  job: Record<string, unknown>,
  canonicalJob: Record<string, unknown>,
  personalReminder: PersonalReminderOrigin,
): void {
  const payload = isRecord(job.payload) ? job.payload : undefined;
  const route = personalReminder;
  const delivery = isRecord(job.delivery) ? job.delivery : {};
  if (
    !route.sessionKey ||
    !route.to ||
    !isRecord(job.schedule) ||
    (job.schedule.kind !== "at" && job.schedule.kind !== "every" && job.schedule.kind !== "cron") ||
    payload?.kind !== "agentTurn" ||
    (canonicalJob.sessionTarget !== undefined &&
      canonicalJob.sessionTarget !== "current" &&
      canonicalJob.sessionTarget !== "isolated") ||
    (canonicalJob.sessionKey !== undefined && canonicalJob.sessionKey !== route.sessionKey) ||
    (canonicalJob.agentId !== undefined && canonicalJob.agentId !== route.agentId)
  ) {
    throw new Error(
      "Caller automations require an agent turn in the original Telegram conversation.",
    );
  }
  // A plain reminder remains tool-free. Operational jobs request their captured tools explicitly.
  payload.toolsAllow ??= [];
  job.sessionTarget = canonicalJob.sessionTarget ?? "current";
  job.sessionKey = route.sessionKey;
  job.agentId = route.agentId;
  if (job.schedule.kind === "at" && job.deleteAfterRun === undefined) {
    job.deleteAfterRun = true;
  }
  job.delivery = {
    mode: "announce",
    channel: "telegram",
    to: route.to,
    accountId: route.accountId,
    threadId: route.threadId,
    ...delivery,
  };
}
