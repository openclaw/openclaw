import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveEmbeddedSessionLane } from "../../../agents/embedded-agent-runner/lanes.js";
import {
  clearCommandLane,
  countQueuedCommandsInLane,
  prepareCommandLaneClear,
} from "../../../process/command-queue.js";
import {
  agentSessionKeysMatchByRequestKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import { defaultRuntime } from "../../../runtime.js";
import { removeQueuedItemsByRef } from "../../../utils/queue-helpers.js";
import { clearFollowupDrainCallback } from "./drain.js";
import { completeFollowupRuns } from "./lifecycle.js";
import { FOLLOWUP_QUEUES, followupQueueSources } from "./state.js";
import { consumeQueueSummaryDelivery } from "./summary-consumption.js";
import type { FollowupRun } from "./types.js";

export type ClearSessionQueueResult = {
  followupCleared: number;
  laneCleared: number;
  keys: string[];
};

export type SessionLifecycleQueueTarget = {
  keys: Array<string | undefined>;
  agentId: string;
  sessionKey: string;
  /** Omit to select every incarnation of this agent's conversation. */
  sessionId?: string;
};

function matchesSessionQueueTarget(
  source: { agentId?: string; sessionKey?: string; sessionId?: string },
  params: {
    agentId: string;
    sessionKey: string;
    sessionKeyAliases?: readonly string[];
    sessionId?: string;
  },
): boolean {
  const agentId = normalizeAgentId(params.agentId);
  const keyAgentId = parseAgentSessionKey(source.sessionKey)?.agentId;
  return (
    normalizeOptionalString(source.agentId) !== undefined &&
    normalizeAgentId(source.agentId) === agentId &&
    (!keyAgentId || normalizeAgentId(keyAgentId) === agentId) &&
    (source.sessionKey === params.sessionKey ||
      params.sessionKeyAliases?.some((key) =>
        agentSessionKeysMatchByRequestKey(source.sessionKey, key),
      ) === true) &&
    (params.sessionId === undefined || source.sessionId === params.sessionId)
  );
}

function matchesSessionFollowupRun(
  source: FollowupRun,
  params: Parameters<typeof matchesSessionQueueTarget>[1],
): boolean {
  return (
    matchesSessionQueueTarget(source.run, params) &&
    (params.sessionId === undefined ||
      source.admissionSessionId === undefined ||
      source.admissionSessionId === params.sessionId)
  );
}

function resolveSessionLifecycleQueueKeys(params: SessionLifecycleQueueTarget) {
  const agentId = normalizeAgentId(params.agentId);
  const keys = [
    ...new Set(
      [...params.keys, params.sessionKey, params.sessionId]
        .map(normalizeOptionalString)
        .filter((key) => key !== undefined)
        .filter((key) => {
          const keyAgentId = parseAgentSessionKey(key)?.agentId;
          return !keyAgentId || normalizeAgentId(keyAgentId) === agentId;
        }),
    ),
  ];
  return {
    keys,
    sessionKeyAliases: keys.filter((key) => key !== params.sessionId),
    matchesLaneEntry:
      (key: string) => (target: Parameters<typeof matchesSessionQueueTarget>[0] | undefined) =>
        target
          ? matchesSessionQueueTarget(target, { ...params, sessionKeyAliases: keys })
          : key === params.sessionId || parseAgentSessionKey(key) !== null,
  };
}

/** Capture pending sources before Stop callbacks can replace their queue or session. */
export function prepareSessionFollowupCleanup(params: {
  keys: Array<string | undefined>;
  agentId: string;
  sessionKey: string;
  sessionKeyAliases?: readonly string[];
  sessionId?: string;
  assertCurrent: () => void;
}): () => number {
  const keys = new Set(
    params.keys.map((key) => normalizeOptionalString(key)).filter((key) => key !== undefined),
  );
  const captures = [...keys].flatMap((key) => {
    const queue = FOLLOWUP_QUEUES.get(key);
    if (!queue) {
      return [];
    }
    const isPending = (source: FollowupRun) =>
      source.steerPending?.phase !== "injecting" &&
      !queue.inFlight.has(source) &&
      !queue.activeSummarySources.has(source);
    // Admission can retarget the next claim before run.sessionId is refreshed.
    // Exact Stop must not transfer to another incarnation; broad Stop includes both.
    const sources = [...new Set(followupQueueSources(queue))].filter(
      (source) => isPending(source) && matchesSessionFollowupRun(source, params),
    );
    return [{ key, queue, isPending, sources }];
  });
  let consumed = false;
  return () => {
    if (consumed) {
      return 0;
    }
    consumed = true;
    let removed = 0;
    for (const { key, queue, isPending, sources } of captures) {
      params.assertCurrent();
      if (FOLLOWUP_QUEUES.get(key) !== queue) {
        continue;
      }
      const matchesCurrentTarget = (source: FollowupRun) =>
        isPending(source) && matchesSessionFollowupRun(source, params);
      const current = sources.filter(matchesCurrentTarget);
      const pending = current.filter((source) => queue.items.includes(source));
      const summaries = current.filter(
        (source) =>
          queue.summarySources.includes(source) ||
          queue.summaryElisions.some((entry) => {
            const mapped = entry.sourceRefs.get(source) ?? source;
            return entry.sources.includes(mapped) && matchesCurrentTarget(mapped);
          }),
      );
      // Detach the whole accepted set before lifecycle callbacks can revoke or re-enter Stop.
      removeQueuedItemsByRef(queue.items, pending);
      consumeQueueSummaryDelivery(
        queue,
        { sources: summaries, droppedCount: summaries.length },
        false,
      );
      const detached = new Set([...pending, ...summaries]);
      removed += detached.size;
      completeFollowupRuns(detached, (error) => {
        defaultRuntime.error?.(`followup queue cancellation settlement failed: ${String(error)}`);
      });
      // Settlement of accepted removals is unconditional; later effects need current authority.
      params.assertCurrent();
      if (
        FOLLOWUP_QUEUES.get(key) === queue &&
        !queue.draining &&
        queue.items.length === 0 &&
        queue.inFlight.size === 0 &&
        queue.droppedCount === 0
      ) {
        FOLLOWUP_QUEUES.delete(key);
        clearFollowupDrainCallback(key);
      }
    }
    return removed;
  };
}

export function clearSessionLifecycleQueues(
  params: SessionLifecycleQueueTarget & { assertCurrent: () => void },
): ClearSessionQueueResult {
  params.assertCurrent();
  const { keys, sessionKeyAliases } = resolveSessionLifecycleQueueKeys(params);
  const followupCleared = prepareSessionFollowupCleanup({
    ...params,
    keys,
    sessionKeyAliases,
  })();
  const laneCleared = clearSessionLifecycleLanes(params);
  return { followupCleared, laneCleared, keys };
}

export function prepareSessionLifecycleQueueCleanup(
  params: SessionLifecycleQueueTarget & { assertCurrent: () => void },
): () => ClearSessionQueueResult {
  params.assertCurrent();
  const { keys, sessionKeyAliases, matchesLaneEntry } = resolveSessionLifecycleQueueKeys(params);
  const clearFollowups = prepareSessionFollowupCleanup({
    ...params,
    keys,
    sessionKeyAliases,
  });
  const lanes = keys.map((key) =>
    prepareCommandLaneClear(resolveEmbeddedSessionLane(key), matchesLaneEntry(key)),
  );
  return () => {
    params.assertCurrent();
    const followupCleared = clearFollowups();
    let laneCleared = 0;
    for (const clearLane of lanes) {
      params.assertCurrent();
      laneCleared += clearLane();
    }
    return { followupCleared, laneCleared, keys };
  };
}

export function clearSessionLifecycleLanes(
  params: SessionLifecycleQueueTarget & { assertCurrent: () => void },
): number {
  const { keys, matchesLaneEntry } = resolveSessionLifecycleQueueKeys(params);
  let laneCleared = 0;
  for (const key of keys) {
    params.assertCurrent();
    laneCleared += clearCommandLane(resolveEmbeddedSessionLane(key), matchesLaneEntry(key));
  }
  return laneCleared;
}

export function hasSessionLifecycleQueueWork(params: SessionLifecycleQueueTarget): boolean {
  const { keys, sessionKeyAliases, matchesLaneEntry } = resolveSessionLifecycleQueueKeys(params);
  for (const key of keys) {
    const queue = FOLLOWUP_QUEUES.get(key);
    if (
      queue &&
      [...followupQueueSources(queue), ...queue.inFlight].some((source) =>
        matchesSessionFollowupRun(source, { ...params, sessionKeyAliases }),
      )
    ) {
      return true;
    }
  }
  return keys.some(
    (key) => countQueuedCommandsInLane(resolveEmbeddedSessionLane(key), matchesLaneEntry(key)) > 0,
  );
}
