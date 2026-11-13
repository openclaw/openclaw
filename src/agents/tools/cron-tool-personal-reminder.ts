import type { PersonalReminderOrigin } from "../../gateway/cron-creator-authority-grant.js";
import { isRecord } from "../../utils.js";

/** Apply the admitted human route and tool-free restriction to a one-shot reminder. */
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
    job.schedule.kind !== "at" ||
    payload?.kind !== "agentTurn" ||
    (payload.toolsAllow !== undefined &&
      (!Array.isArray(payload.toolsAllow) || payload.toolsAllow.length !== 0)) ||
    (canonicalJob.sessionTarget !== undefined && canonicalJob.sessionTarget !== "current") ||
    (canonicalJob.sessionKey !== undefined && canonicalJob.sessionKey !== route.sessionKey) ||
    (canonicalJob.agentId !== undefined && canonicalJob.agentId !== route.agentId)
  ) {
    throw new Error(
      "Personal reminders require one tool-free occurrence in the current Telegram conversation.",
    );
  }
  payload.toolsAllow = [];
  job.sessionTarget = "current";
  job.sessionKey = route.sessionKey;
  job.agentId = route.agentId;
  job.deleteAfterRun = true;
  job.delivery = {
    mode: "announce",
    channel: "telegram",
    to: route.to,
    accountId: route.accountId,
    threadId: route.threadId,
    ...delivery,
  };
}
