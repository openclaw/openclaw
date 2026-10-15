/** Cloneable facts needed to deliver one committed cron notification. */
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeOptionalAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveCronDeliverySessionKey } from "../session-target.js";
import type { CronJob, CronMessageChannel } from "../types.js";

export type CronNotificationRouting = { defaultAgentId?: string };

export function captureCronNotificationRouting(
  rawDefaultAgentId: string | undefined,
  configuredDefaultAgentId: string | undefined,
): CronNotificationRouting {
  const defaultAgentId =
    normalizeOptionalAgentId(rawDefaultAgentId) ??
    normalizeOptionalAgentId(configuredDefaultAgentId);
  return defaultAgentId === undefined ? {} : { defaultAgentId };
}

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

export function resolveCronNotificationQueueOwner(
  job: CronNotificationJob,
  kind: CronNotificationIntent["kind"],
) {
  const sessionKey = kind === "failure-alert" ? resolveCronDeliverySessionKey(job) : job.sessionKey;
  const agentId =
    normalizeOptionalAgentId(job.agentId) ??
    normalizeOptionalAgentId(parseAgentSessionKey(sessionKey)?.agentId);
  return { agentId, sessionKey };
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

type CronFailureAlertNotification = {
  kind: "failure-alert";
  job: CronNotificationJob;
  payload: ReplyPayload;
  runAtMs?: number;
  route: CronFailureAlertRoute;
};

export type CronNotificationIntent = { routing?: CronNotificationRouting } & (
  | { kind: "auto-disabled"; job: CronNotificationJob; text: string }
  | {
      kind: "failure-repair";
      job: CronNotificationJob;
      text: string;
      fallback?: CronFailureAlertNotification;
    }
  | CronFailureAlertNotification
);
