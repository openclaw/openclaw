import {
  stripOutboundTargetKindPrefix,
  stripTargetTopicSuffix,
  stripTargetProviderPrefix,
} from "../../infra/outbound/channel-target-prefix.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { CronJob } from "../types.js";
import { resolveCronExecCompletionSession } from "./completion-session-key.js";

/**
 * Picks the session-key identity used to resolve a cron delivery's outbound route.
 *
 * An isolated run does not carry its bound source conversation's namespace.
 * Reuse only a canonical conversation belonging to the same agent, actual
 * delivery provider, and destination; otherwise jobs can adopt another peer's
 * conversation or thread.
 */
export function selectCronRouteCurrentSessionKey(
  job: CronJob,
  agentSessionKey: string,
  deliveryProvider: string,
  deliveryTarget: string,
  deliveryThreadId?: string | number,
): string {
  const bound = (job.sessionKey ?? "").trim();
  const parsedBound = parseAgentSessionKey(bound);
  const parsedRun = parseAgentSessionKey(agentSessionKey);
  if (!parsedBound || !parsedRun || parsedBound.agentId !== parsedRun.agentId) {
    return agentSessionKey;
  }
  const conversation =
    /^([^:]+):(direct|group|channel):([^:]+)(?::(?:thread|topic):([^:]+))?$/i.exec(
      parsedBound.rest,
    );
  const normalizedTarget = stripOutboundTargetKindPrefix(
    stripTargetProviderPrefix(deliveryTarget, deliveryProvider),
  );
  const targetPeerId = stripTargetTopicSuffix(normalizedTarget);
  const targetTopicId = /:topic:(.+)$/i.exec(normalizedTarget)?.[1];
  const effectiveThreadId = deliveryThreadId == null ? targetTopicId : String(deliveryThreadId);
  if (
    conversation?.[1]?.toLowerCase() !== deliveryProvider.trim().toLowerCase() ||
    conversation[3] !== targetPeerId ||
    (effectiveThreadId != null && (conversation[4] ?? "") !== effectiveThreadId)
  ) {
    return agentSessionKey;
  }
  return bound;
}

/** Resolves a saved, generation-fenced completion owner for one cron delivery route. */
export function resolveCronRouteCompletionSession(params: {
  job: CronJob;
  agentSessionKey: string;
  sourceSessionKey?: string;
  usesDetachedRunSession: boolean;
  delivery: { channel?: string; to?: string; threadId?: string | number };
  sessionStore: Record<string, { sessionId: string; lifecycleRevision?: string } | undefined>;
}) {
  const routeSessionKey =
    params.delivery.channel && params.delivery.to
      ? selectCronRouteCurrentSessionKey(
          params.job,
          params.agentSessionKey,
          params.delivery.channel,
          params.delivery.to,
          params.delivery.threadId,
        )
      : params.agentSessionKey;
  return resolveCronExecCompletionSession({
    usesDetachedRunSession: params.usesDetachedRunSession,
    runSessionKey: params.agentSessionKey,
    completionSessionKey: params.sourceSessionKey ?? routeSessionKey,
    sessionStore: params.sessionStore,
  });
}
