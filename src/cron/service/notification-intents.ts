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

/** Capture only a needed default and keep that recipient current through native commit. */
export function prepareCronNotificationRouting(
  deps: { defaultAgentId?: string; resolveDefaultAgentId?: () => string | undefined },
  needed: boolean,
) {
  const capture = () =>
    captureCronNotificationRouting(deps.resolveDefaultAgentId?.(), deps.defaultAgentId);
  const routing: CronNotificationRouting = needed ? capture() : {};
  return {
    routing,
    assertCurrent() {
      if (needed && capture().defaultAgentId !== routing.defaultAgentId) {
        throw new Error("Cron notification default owner changed before commit");
      }
    },
  };
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

export type CronNotificationIntent = { routing?: CronNotificationRouting } & (
  | { kind: "auto-disabled"; job: CronNotificationJob; text: string }
  | {
      kind: "failure-alert";
      job: CronNotificationJob;
      payload: ReplyPayload;
      runAtMs?: number;
      route: CronFailureAlertRoute;
    }
);
