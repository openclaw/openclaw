import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import type { SessionObserverEvent } from "./session-observer-contract.js";
import {
  isSameSessionObserverLifecycle,
  markSessionObserverRunSuperseded,
  rememberSessionObserverRevisionFloor,
  resolveSessionObserverDigestForLifecycle,
  snapshotSessionObserverRevisionFloor,
} from "./session-observer-model.js";
import type {
  DormantSessionObserverRun,
  SessionObserverDeps,
  SessionObserverRevisionFloor,
  SessionObserverState,
} from "./session-observer-model.js";
import { onGatewaySessionReset } from "./session-reset-notifications.js";
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";

type ReadSession = NonNullable<SessionObserverDeps["readSession"]>;

export function createSessionObserverLifecycle(params: {
  getConfig: SessionObserverDeps["getConfig"];
  readSession: ReadSession;
  refreshAfterReset: (
    sessionKey: string,
    agentId: string,
    consume: (session: ReturnType<ReadSession>) => void,
  ) => void;
  now: () => number;
  isTerminal: (runId: string) => boolean;
  clearPendingTerminalError: (runId: string) => void;
  releaseState: (state: SessionObserverState) => void;
}) {
  const states = new Map<string, SessionObserverState>();
  const dormantRuns = new Map<string, DormantSessionObserverRun>();
  const revisionFloors = new Map<string, SessionObserverRevisionFloor>();
  const supersededRuns = new Map<string, number>();
  const disabledRuns = new Set<string>();

  const isTracked = (state: SessionObserverState): boolean =>
    states.get(resolveSessionSubscriptionKey(state.sessionKey, state.agentId)) === state;

  const dropState = (state: SessionObserverState) => {
    params.releaseState(state);
    if (isTracked(state)) {
      const scopeKey = resolveSessionSubscriptionKey(state.sessionKey, state.agentId);
      if (
        state.terminalHealth === "failed" &&
        !params.isTerminal(state.runId) &&
        !supersededRuns.has(state.runId) &&
        state.previousDigest
      ) {
        rememberSessionObserverRevisionFloor(
          revisionFloors,
          scopeKey,
          snapshotSessionObserverRevisionFloor(state),
        );
      }
      states.delete(scopeKey);
    }
  };

  const retireRun = (runId: string) => {
    markSessionObserverRunSuperseded(supersededRuns, runId, params.now());
    params.clearPendingTerminalError(runId);
    dormantRuns.delete(runId);
    disabledRuns.delete(runId);
  };

  const retireObsolete = (scopeKey: string, session: ReturnType<ReadSession>): void => {
    const matches = (owner: SessionObserverRevisionFloor) => {
      try {
        owner.reader?.assertCurrent();
        return isSameSessionObserverLifecycle(owner, session);
      } catch {
        return false;
      }
    };
    const state = states.get(scopeKey);
    if (state && !matches(state)) {
      retireRun(state.runId);
      dropState(state);
    }
    for (const run of dormantRuns.values()) {
      if (
        resolveSessionSubscriptionKey(run.sessionKey, run.agentId) === scopeKey &&
        !matches(run)
      ) {
        retireRun(run.runId);
      }
    }
    const floor = revisionFloors.get(scopeKey);
    if (floor && !matches(floor)) {
      if (floor.previousDigest?.runId) {
        retireRun(floor.previousDigest.runId);
      }
      revisionFloors.delete(scopeKey);
    }
  };

  const acceptPublication = (
    state: SessionObserverState,
    session: ReturnType<ReadSession>,
  ): boolean => {
    if (!isTracked(state)) {
      return false;
    }
    if (isSameSessionObserverLifecycle(state, session)) {
      return true;
    }
    retireObsolete(resolveSessionSubscriptionKey(state.sessionKey, state.agentId), session);
    return false;
  };

  const admit = (
    event: SessionObserverEvent,
    sessionKey: string,
    agentId: string,
    session: ReturnType<ReadSession>,
    utilityModelRef: string | undefined,
  ): SessionObserverState => {
    const scopeKey = resolveSessionSubscriptionKey(sessionKey, agentId);
    const dormant = dormantRuns.get(event.runId);
    if (dormant && isSameSessionObserverLifecycle(dormant, session)) {
      dormantRuns.delete(event.runId);
      const { utilityModelRef: _dormantModelRef, ...dormantState } = dormant;
      const state: SessionObserverState = {
        ...createSessionActivityNoteState(),
        ...dormantState,
        ...(dormantState.lastPreambleHeadline
          ? { lastPublishedPreambleHeadline: dormantState.lastPreambleHeadline }
          : {}),
        ...(utilityModelRef ? { utilityModelRef } : {}),
        lastActivityAt: event.ts,
        lastRunAt: params.now(),
        lastDigestNoteSequence: 0,
        inFlight: false,
        finalPending: false,
      };
      states.set(scopeKey, state);
      return state;
    }
    const previousDigest = resolveSessionObserverDigestForLifecycle(
      session?.observerDigest,
      session,
    );
    const startedAt =
      asFiniteNumber(event.data.startedAt) ?? session?.startedAt ?? event.ts ?? params.now();
    const state: SessionObserverState = {
      ...createSessionActivityNoteState(),
      sessionKey,
      sessionId: session?.sessionId,
      lifecycleRevision: session?.lifecycleRevision,
      runId: event.runId,
      agentId,
      ...(utilityModelRef ? { utilityModelRef } : {}),
      startedAt,
      lastActivityAt: event.ts,
      lastRunAt: startedAt,
      lastPersistedAt: previousDigest?.updatedAt,
      revision: previousDigest?.revision ?? 0,
      digestCount: 0,
      consecutiveFailures: 0,
      lastDigestNoteSequence: 0,
      previousDigest,
      inFlight: false,
      finalPending: false,
    };
    states.set(scopeKey, state);
    return state;
  };

  const unsubscribeReset = onGatewaySessionReset((sessionKey, suppliedAgentId) => {
    const agentId =
      suppliedAgentId ?? resolveSessionAgentId({ sessionKey, config: params.getConfig() });
    // Reset notification can follow awaited cleanup. Preserve a newer admitted owner.
    params.refreshAfterReset(sessionKey, agentId, (session) =>
      retireObsolete(resolveSessionSubscriptionKey(sessionKey, agentId), session),
    );
  });

  return {
    states,
    dormantRuns,
    revisionFloors,
    supersededRuns,
    disabledRuns,
    isTracked,
    dropState,
    retireObsolete,
    acceptPublication,
    admit,
    dispose() {
      unsubscribeReset();
      for (const state of states.values()) {
        dropState(state);
      }
      dormantRuns.clear();
      revisionFloors.clear();
      supersededRuns.clear();
      disabledRuns.clear();
    },
  };
}
