/** Cloneable facts needed to deliver one committed cron notification. */
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeOptionalAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import {
  resolveCronDeliverySessionKey,
  resolveCronSelectedConversation,
} from "../session-target.js";
import type { CronJob, CronMessageChannel, CronStoredJob } from "../types.js";

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
  /**
   * The selected conversation that receives primary-route and safety notices. `null` marks a
   * selection without a captured generation: notices then fail over to the owning agent, never
   * to the creating conversation or a remembered route.
   */
  deliveryConversation?: CronStoredJob["deliveryConversation"] | null;
  state: Pick<
    CronJob["state"],
    "lastRunAtMs" | "lastFailureAlertAtMs" | "lastFailureNotificationId"
  >;
};

export function cronNotificationJob(
  job: CronJob & Pick<CronStoredJob, "deliveryConversation">,
): CronNotificationJob {
  const deliveryConversation = resolveCronSelectedConversation(job);
  return {
    id: job.id,
    name: job.name,
    agentId: job.agentId,
    sessionTarget: job.sessionTarget,
    sessionKey: job.sessionKey,
    wakeMode: job.wakeMode,
    ...(deliveryConversation !== undefined
      ? { deliveryConversation: deliveryConversation && { ...deliveryConversation } }
      : {}),
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
  // A job with a selected conversation must not fall back into its creating or execution
  // session; its owning agent's main session receives the in-app notice instead.
  if (job.deliveryConversation !== undefined) {
    return { agentId: tryResolveCronJobEffectiveAgentId(job), sessionKey: undefined };
  }
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
  | {
      kind: "auto-disabled";
      job: CronNotificationJob;
      text: string;
      /** When the job was disabled or paused; identifies this notice in a conversation. */
      atMs: number;
    }
  | {
      kind: "failure-repair";
      job: CronNotificationJob;
      text: string;
      fallback?: CronFailureAlertNotification;
    }
  | CronFailureAlertNotification
);
