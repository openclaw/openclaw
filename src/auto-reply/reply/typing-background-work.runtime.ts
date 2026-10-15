import {
  observeAgentRunHumanWait,
  type AgentRunHumanWait,
} from "../../agents/agent-run-approval-wait.js";
/** Live, request-scoped activity owned by native children and background exec. */
import {
  listActiveBackgroundProcessSessions,
  subscribeProcessSessionChanges,
} from "../../agents/bash-process-registry.js";
import { observeSubagentExecution } from "../../agents/subagents/registry/subagent-execution-observation.js";
import { subscribeSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunLive,
  isSubagentRunQueued,
  listSubagentRunsForRequester,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { isRequesterYieldCohortMember } from "../../agents/subagents/registry/subagent-requester-settle-identity.js";
import { isSameSubagentRunOwner } from "../../agents/subagents/registry/subagent-run-generation.js";
import { onAgentEventForRun } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";

export type ReplyBackgroundWorkState = "active" | "waiting" | "none";

export type ReplyBackgroundWorkObserver = {
  /** Re-read only authoritative process-local owners; never infer from a session row. */
  currentState: () => ReplyBackgroundWorkState;
  dispose: () => void;
};

type RequesterScope = { sessionKey: string; requesterAgentId: string; requesterRunId: string };
type ChildHumanWaitOwner = {
  entry: SubagentRunRecord;
  sessionId?: string;
  lifecycleGeneration?: string;
  observer: AgentRunHumanWait;
};

function isChildLinkedToRequesterRun(entry: SubagentRunRecord, scope: RequesterScope): boolean {
  return (
    entry.requesterSessionKey === scope.sessionKey &&
    entry.requesterAgentId === scope.requesterAgentId &&
    entry.requesterTurnRunId === scope.requesterRunId &&
    entry.expectsCompletionMessage === true &&
    entry.collect !== true &&
    !entry.killIntent &&
    !entry.killReconciliation &&
    entry.suppressCompletionDelivery !== true
  );
}

function isYieldedChildOwnedByRequest(entry: SubagentRunRecord, scope: RequesterScope): boolean {
  return isChildLinkedToRequesterRun(entry, scope) && entry.requesterTurnYielded === true;
}

function getVisibleYieldSettleWake(entry: SubagentRunRecord) {
  const wake = entry.requesterSettleWake;
  const rearmGeneration = wake?.rearmGeneration;
  const batchRunIds = wake?.batchRunIds;
  if (
    entry.requesterTurnRunId !== undefined ||
    entry.requesterTurnYielded === true ||
    wake?.status !== "pending" ||
    wake.attemptCount !== 0 ||
    wake.yieldedFinalDeliverable !== true ||
    typeof rearmGeneration !== "number" ||
    !Number.isSafeInteger(rearmGeneration) ||
    !batchRunIds ||
    !isRequesterYieldCohortMember(entry, batchRunIds, rearmGeneration)
  ) {
    return undefined;
  }
  return { rearmGeneration, batchRunIds };
}

function isSameVisibleYieldWake(
  left: { rearmGeneration: number; batchRunIds: readonly string[] },
  right: { rearmGeneration: number; batchRunIds: readonly string[] },
): boolean {
  return (
    left.rearmGeneration === right.rearmGeneration &&
    left.batchRunIds.length === right.batchRunIds.length &&
    left.batchRunIds.every((runId, index) => runId === right.batchRunIds[index])
  );
}

function isCurrentChildGeneration(entry: SubagentRunRecord): boolean {
  const childAgentId = entry.childAgentId ?? parseAgentSessionKey(entry.childSessionKey)?.agentId;
  if (!childAgentId) {
    return false;
  }
  const latest = getLatestLiveSubagentRunByChildSessionKey(
    entry.childSessionKey,
    undefined,
    childAgentId,
  );
  return Boolean(latest && isSameSubagentRunOwner(latest, entry));
}

function isYieldedParent(entry: SubagentRunRecord): boolean {
  return (
    entry.pauseReason === "sessions_yield" &&
    !entry.killIntent &&
    !entry.killReconciliation &&
    entry.suppressAnnounceReason !== "killed" &&
    entry.endedReason !== "subagent-killed"
  );
}

/**
 * Follows only the exact requester->run lineage. A yielded child itself is not
 * execution; its current executing descendants may still be attributed to the
 * same original visible requester. Each edge must be a current yielded batch.
 */
export function createReplyBackgroundWorkObserver(params: {
  sessionKey: string;
  runId: string;
  onChange: (state: ReplyBackgroundWorkState) => void;
}): ReplyBackgroundWorkObserver {
  const sessionKey = params.sessionKey.trim();
  const runId = params.runId.trim();
  const requesterAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  let state: ReplyBackgroundWorkState = "none";
  let disposed = false;
  let refreshing = false;
  let refreshAgain = false;
  const terminalRunIds = new Set<string>();
  const yieldedParentRunIds = new Set<string>();
  const childListeners = new Map<string, () => void>();
  const childRunOwners = new Map<string, SubagentRunRecord>();
  const childHumanWaitObservers = new Map<string, ChildHumanWaitOwner>();
  const requesterTurnLineage = new Map<string, SubagentRunRecord>();
  const requesterYieldWakeOwners = new Map<
    string,
    { rearmGeneration: number; batchRunIds: readonly string[] }
  >();

  if (!sessionKey || !runId || !requesterAgentId) {
    return { currentState: () => "none", dispose: () => {} };
  }

  const publish = (next: ReplyBackgroundWorkState) => {
    if (next === state || disposed) {
      return;
    }
    state = next;
    try {
      params.onChange(next);
    } catch {
      // Typing is best-effort; an observer failure must not affect run ownership.
    }
  };

  const refresh = () => {
    if (disposed) {
      return;
    }
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        const scopes: RequesterScope[] = [{ sessionKey, requesterAgentId, requesterRunId: runId }];
        const visited = new Set<string>();
        const currentRunIds = new Set<string>();
        const currentRequesterLineage = new Set<string>();
        const nextYieldedParents = new Set<string>();
        let active = false;
        let waiting = false;

        // Traverse only explicit requester-yield edges. A yielded parent is a
        // handoff node, not execution; a running descendant is the actual owner.
        while (scopes.length > 0) {
          const scope = scopes.pop();
          if (!scope) {
            continue;
          }
          const children: SubagentRunRecord[] = [];
          for (const entry of listSubagentRunsForRequester(scope.sessionKey, {
            requesterAgentId: scope.requesterAgentId,
          }).filter(isCurrentChildGeneration)) {
            const lineageKey = JSON.stringify([
              scope.sessionKey,
              scope.requesterAgentId,
              scope.requesterRunId,
              entry.runId,
            ]);
            const directlyLinked = isChildLinkedToRequesterRun(entry, scope);
            if (directlyLinked) {
              requesterTurnLineage.set(lineageKey, entry);
              if (entry.requesterTurnYielded === true) {
                requesterYieldWakeOwners.delete(lineageKey);
              }
            }
            const recordedOwner = requesterTurnLineage.get(lineageKey);
            const visibleWake = getVisibleYieldSettleWake(entry);
            const previousWake = requesterYieldWakeOwners.get(lineageKey);
            const transferredYield =
              recordedOwner !== undefined &&
              isSameSubagentRunOwner(recordedOwner, entry) &&
              visibleWake !== undefined &&
              (previousWake === undefined || isSameVisibleYieldWake(previousWake, visibleWake));
            if (transferredYield && visibleWake) {
              requesterYieldWakeOwners.set(lineageKey, visibleWake);
            }
            if (directlyLinked || transferredYield) {
              currentRequesterLineage.add(lineageKey);
            }
            if (isYieldedChildOwnedByRequest(entry, scope) || transferredYield) {
              children.push(entry);
            }
          }
          for (const child of children) {
            const identity = String(child.generation ?? child.createdAt) + ":" + child.runId;
            if (visited.has(identity)) {
              continue;
            }
            visited.add(identity);
            currentRunIds.add(child.runId);
            const previousOwner = childRunOwners.get(child.runId);
            if (previousOwner && !isSameSubagentRunOwner(previousOwner, child)) {
              childListeners.get(child.runId)?.();
              childListeners.delete(child.runId);
              const previousWait = childHumanWaitObservers.get(child.runId);
              previousWait?.observer.dispose();
              childHumanWaitObservers.delete(child.runId);
              terminalRunIds.delete(child.runId);
              yieldedParentRunIds.delete(child.runId);
            }
            childRunOwners.set(child.runId, child);
            const yieldedParent = isYieldedParent(child);
            if (yieldedParent) {
              nextYieldedParents.add(child.runId);
              // The lifecycle end is the yield transfer, not task completion.
              terminalRunIds.delete(child.runId);
            }
            if (!childListeners.has(child.runId)) {
              childListeners.set(
                child.runId,
                onAgentEventForRun(child.runId, (event) => {
                  if (
                    event.runId !== child.runId ||
                    !isSameSubagentRunOwner(childRunOwners.get(child.runId), child)
                  ) {
                    return;
                  }
                  if (
                    event.stream === "lifecycle" &&
                    (event.data.phase === "end" || event.data.phase === "error") &&
                    !(event.data.phase === "end" && yieldedParentRunIds.has(child.runId))
                  ) {
                    terminalRunIds.add(child.runId);
                    const waitOwner = childHumanWaitObservers.get(child.runId);
                    if (waitOwner && isSameSubagentRunOwner(waitOwner.entry, child)) {
                      waitOwner.observer.dispose();
                      childHumanWaitObservers.delete(child.runId);
                    }
                  }
                  refresh();
                }),
              );
            }
            if (terminalRunIds.has(child.runId)) {
              continue;
            }
            const childAgentId =
              child.childAgentId ?? parseAgentSessionKey(child.childSessionKey)?.agentId;
            if (!childAgentId) {
              continue;
            }
            const live = isSubagentRunLive(child);
            const queued = isSubagentRunQueued(child);
            const mayFollowDescendants = yieldedParent;
            if (live) {
              const humanWait = getChildHumanWaitObserver(child);
              const descendants = listSubagentRunsForRequester(child.childSessionKey, {
                requesterAgentId: childAgentId,
              });
              const observation = observeSubagentExecution(child, descendants);
              if (humanWait?.waiting || humanWait?.resumeRequired) {
                // An exact human wait outranks the generic running projection until
                // the same execution owner reports that it has resumed.
                waiting = true;
                continue;
              }
              if (observation.state === "running") {
                active = true;
                continue;
              }
              if (observation.state === "waiting" && observation.wait?.kind === "children") {
                scopes.push({
                  sessionKey: child.childSessionKey,
                  requesterAgentId: childAgentId,
                  requesterRunId: child.runId,
                });
                continue;
              }
              if (observation.state === "waiting" || observation.state === "queued") {
                // Approval, human input, and other waits are not active work.
                waiting = true;
                continue;
              }
              // Unknown activity fails closed and is not retained as a work owner.
              continue;
            }
            if (queued) {
              waiting = true;
              continue;
            }
            if (mayFollowDescendants) {
              // The parent execution ended by explicit yield. Inspect only its
              // exact current child cohort; stale stored descendants do not count.
              scopes.push({
                sessionKey: child.childSessionKey,
                requesterAgentId: childAgentId,
                requesterRunId: child.runId,
              });
            }
          }
        }

        for (const lineageKey of requesterTurnLineage.keys()) {
          if (!currentRequesterLineage.has(lineageKey)) {
            requesterTurnLineage.delete(lineageKey);
            requesterYieldWakeOwners.delete(lineageKey);
          }
        }
        yieldedParentRunIds.clear();
        for (const childRunId of nextYieldedParents) {
          yieldedParentRunIds.add(childRunId);
        }
        for (const [childRunId, unsubscribe] of childListeners) {
          if (!currentRunIds.has(childRunId)) {
            unsubscribe();
            childListeners.delete(childRunId);
            childRunOwners.delete(childRunId);
            childHumanWaitObservers.get(childRunId)?.observer.dispose();
            childHumanWaitObservers.delete(childRunId);
            terminalRunIds.delete(childRunId);
            yieldedParentRunIds.delete(childRunId);
          }
        }

        const hasAttributedProcess = listActiveBackgroundProcessSessions().some(
          (processSession) =>
            processSession.agentRunId === runId &&
            processSession.sessionKey === sessionKey &&
            processSession.scopeKey === sessionKey &&
            processSession.backgrounded &&
            !processSession.exited &&
            !processSession.finalizing &&
            !processSession.cancellationRequested &&
            processSession.terminalStatus === undefined &&
            Number.isFinite(processSession.startedAt) &&
            processSession.startedAt <= Date.now() &&
            typeof processSession.pid === "number" &&
            processSession.pid > 0 &&
            processSession.processActivity !== undefined &&
            !processSession.processActivity.resultSettled,
        );
        if (active || hasAttributedProcess) {
          publish("active");
        } else if (waiting) {
          publish("waiting");
        } else {
          publish("none");
        }
        if (disposed) {
          break;
        }
      } while (refreshAgain);
    } finally {
      refreshing = false;
    }
  };

  const getChildHumanWaitObserver = (entry: SubagentRunRecord): AgentRunHumanWait | undefined => {
    const context = getAgentRunContext(entry.runId);
    const existing = childHumanWaitObservers.get(entry.runId);
    if (!context || context.sessionKey !== entry.childSessionKey) {
      existing?.observer.dispose();
      childHumanWaitObservers.delete(entry.runId);
      return undefined;
    }
    if (
      existing &&
      isSameSubagentRunOwner(existing.entry, entry) &&
      existing.sessionId === context.sessionId &&
      existing.lifecycleGeneration === context.lifecycleGeneration
    ) {
      return existing.observer;
    }
    existing?.observer.dispose();
    const observer = observeAgentRunHumanWait({
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    });
    observer.onChange = refresh;
    childHumanWaitObservers.set(entry.runId, {
      entry,
      sessionId: context.sessionId,
      lifecycleGeneration: context.lifecycleGeneration,
      observer,
    });
    return observer;
  };

  const unsubscribeRegistry = subscribeSubagentRunChanges("projection", refresh);
  const unsubscribeProcesses = subscribeProcessSessionChanges(refresh);
  // Subscribe before reading so a registration/terminal publication cannot be lost.
  refresh();

  return {
    currentState: () => {
      refresh();
      return state;
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeRegistry();
      unsubscribeProcesses();
      for (const unsubscribe of childListeners.values()) {
        unsubscribe();
      }
      childListeners.clear();
      for (const { observer } of childHumanWaitObservers.values()) {
        observer.dispose();
      }
      childHumanWaitObservers.clear();
      childRunOwners.clear();
      terminalRunIds.clear();
      yieldedParentRunIds.clear();
      requesterTurnLineage.clear();
      requesterYieldWakeOwners.clear();
    },
  };
}
