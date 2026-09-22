/** Cloneable facts needed to deliver one committed cron notification. */
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { CronJob, CronMessageChannel } from "../types.js";

export type CronNotificationJob = Pick<
  CronJob,
  "id" | "name" | "agentId" | "sessionTarget" | "sessionKey" | "wakeMode"
> & {
  state: Pick<
    CronJob["state"],
    "lastRunAtMs" | "lastFailureAlertAtMs" | "lastFailureNotificationId"
  >;
};

export function cronNotificationJob(job: CronJob): CronNotificationJob {
  return {
    id: job.id,
    name: job.name,
    agentId: job.agentId,
    sessionTarget: job.sessionTarget,
    sessionKey: job.sessionKey,
    wakeMode: job.wakeMode,
    state: {
      lastRunAtMs: job.state.lastRunAtMs,
      lastFailureAlertAtMs: job.state.lastFailureAlertAtMs,
      lastFailureNotificationId: job.state.lastFailureNotificationId,
    },
  };
}

type CronFailureAlertRoute = {
  channel: CronMessageChannel;
  to?: string;
  mode?: "announce" | "webhook";
  accountId?: string;
  threadId?: string | number;
  alternateRoute: boolean;
};

export type ResolvedFailureAlert = CronFailureAlertRoute & {
  after: number;
  cooldownMs: number;
  includeSkipped: boolean;
};

export type CronNotificationIntent =
  | { kind: "auto-disabled"; job: CronNotificationJob; text: string }
  | {
      kind: "failure-alert";
      job: CronNotificationJob;
      payload: ReplyPayload;
      runAtMs?: number;
      route: CronFailureAlertRoute;
    };
