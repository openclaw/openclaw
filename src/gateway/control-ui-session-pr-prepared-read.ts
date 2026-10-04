import { sessionChanges } from "../sessions/session-row-changes.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import type {
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequests,
} from "./control-ui-contract.js";
import {
  prepareControlUiSessionPrServiceTarget,
  type ControlUiSessionPrTarget,
  type ControlUiSessionPrReadContext,
} from "./control-ui-session-pr-read.js";
import type { ControlUiSessionPullRequestsParams } from "./control-ui-session-prs.js";
import type { SessionRowProjection } from "./session-row-projection.js";

export type LoadSessionPullRequests = (
  params: ControlUiSessionPullRequestsParams,
  cacheSignal: AbortSignal | undefined,
  read: ControlUiSessionPrReadContext,
) => Promise<ControlUiSessionPullRequests>;

export async function loadSessionPullRequests(
  params: ControlUiSessionPullRequestsParams,
  cacheSignal: AbortSignal | undefined,
  read: ControlUiSessionPrReadContext,
): Promise<ControlUiSessionPullRequests> {
  read.assertCurrent();
  const { loadControlUiSessionPullRequests } = await import("./control-ui-session-prs.js");
  return loadControlUiSessionPullRequests(params, { cacheSignal, read });
}

export function pushedSnapshot(
  result: ControlUiSessionPullRequests,
): ControlUiSessionPullRequestSnapshot {
  return {
    ...result,
    status: result.status ?? (result.rateLimited ? "rate-limited" : "ready"),
  };
}

export const UNAVAILABLE_SNAPSHOT: ControlUiSessionPullRequestSnapshot = {
  pullRequests: [],
  rateLimited: false,
  status: "unavailable",
};

export type PreparedSessionPrState = {
  connIds: Set<string>;
  target: ControlUiSessionPrTarget;
  cacheLifetime: AbortController;
  snapshot?: ControlUiSessionPullRequestSnapshot;
  prepared?: boolean;
};

/** Background readers publish into the subscription owner's existing cells and concurrency. */
export function createControlUiSessionPrPreparedRead<State extends PreparedSessionPrState>(deps: {
  scope: Pick<AsyncWorkScope, "isClosing" | "track">;
  limit: <T>(run: () => Promise<T>) => Promise<T>;
  withSource: <T>(
    target: ControlUiSessionPrTarget,
    operation: (assertCurrent: () => void, sourceIdentity: string) => Promise<T>,
  ) => Promise<T>;
  load: LoadSessionPullRequests;
  keyStates: Map<string, State>;
  stateForTarget: (sessionKey: string, target: ControlUiSessionPrTarget) => State;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
}) {
  const { scope, limit, withSource, load, keyStates, stateForTarget } = deps;
  const preparing = new Map<State, Promise<void>>();
  const publishSnapshot = (state: State, snapshot: ControlUiSessionPullRequestSnapshot) => {
    const changed = JSON.stringify(state.snapshot) !== JSON.stringify(snapshot);
    state.snapshot = snapshot;
    if (changed && state.prepared) {
      sessionChanges.emit({
        ...state.target.params,
        scope: "runtime",
      });
    }
  };

  const read = (
    target: ControlUiSessionPrTarget,
    assertCurrent: () => void,
    projection?: ControlUiSessionPrReadContext["projection"],
  ): Promise<ControlUiSessionPullRequestSnapshot> => {
    const state = keyStates.get(target.params.sessionKey);
    const previous = state?.snapshot;
    const assertActive = () => {
      if (scope.isClosing) {
        throw new Error("Session pull-request owner is closed");
      }
      assertCurrent();
      target.assertCurrent?.();
    };
    const publish = (snapshot: ControlUiSessionPullRequestSnapshot) => {
      // A retry may replace stale facts, but never a newer watcher publication.
      if (
        projection !== "publication" &&
        state?.prepared &&
        keyStates.get(target.params.sessionKey) === state &&
        state.snapshot === previous &&
        state.target.identity === target.identity
      ) {
        publishSnapshot(state, snapshot);
      }
    };
    assertActive();
    return scope.track(() =>
      limit(async () => {
        assertActive();
        return await withSource(target, async (assertSourceCurrent, sourceIdentity) => {
          const assertReadCurrent = () => {
            assertActive();
            assertSourceCurrent();
          };
          assertReadCurrent();
          try {
            const result = await load(target.params, undefined, {
              target,
              sourceIdentity,
              projection,
              assertCurrent: assertReadCurrent,
            });
            assertReadCurrent();
            const snapshot = pushedSnapshot(result);
            publish(snapshot);
            return snapshot;
          } catch {
            assertReadCurrent();
            publish(UNAVAILABLE_SNAPSHOT);
            return { ...UNAVAILABLE_SNAPSHOT };
          }
        });
      }),
    );
  };
  const readPrepared = (target: ControlUiSessionPrTarget, admitLoad?: () => boolean) => {
    if (scope.isClosing) {
      return undefined;
    }
    const state = stateForTarget(target.params.sessionKey, target);
    const preparedTarget = state.target;
    state.prepared = true;
    if (target.source === null) {
      state.snapshot ??= { pullRequests: [], rateLimited: false, status: "ready" };
    }
    const getProjection = deps.getSessionRowProjection;
    if (
      (!state.snapshot || state.snapshot.status !== "ready" || state.snapshot.rateLimited) &&
      !preparing.has(state) &&
      getProjection &&
      (!admitLoad || admitLoad())
    ) {
      const promise = runInDetachedAsyncContext(() =>
        scope.track(async () => {
          const current = await limit(async () => {
            if (scope.isClosing || keyStates.get(preparedTarget.params.sessionKey) !== state) {
              return undefined;
            }
            return await prepareControlUiSessionPrServiceTarget(
              getProjection,
              preparedTarget.params,
            );
          });
          if (!current) {
            return;
          }
          const assertCurrent = () => {
            if (
              scope.isClosing ||
              keyStates.get(preparedTarget.params.sessionKey) !== state ||
              current.identity !== preparedTarget.identity
            ) {
              throw new Error("Prepared session pull-request target changed");
            }
            current.assertCurrent?.();
          };
          assertCurrent();
          await read(current, assertCurrent);
        }),
      )
        .catch(() => {})
        .finally(() => preparing.delete(state));
      preparing.set(state, promise);
    }
    return state.snapshot;
  };

  const unsubscribeFacts = sessionChanges.subscribeFacts((change) => {
    if (
      "sessionKey" in change &&
      (change.facts?.kind === "unchanged" ||
        (change.scope === "runtime" && !change.facts && !change.factsInvalidated))
    ) {
      return;
    }
    const affected =
      "sessionKey" in change
        ? ([[change.sessionKey, keyStates.get(change.sessionKey)]] as const)
        : keyStates;
    const invalidated: Array<ControlUiSessionPrTarget["params"]> = [];
    for (const [key, state] of affected) {
      if (state?.prepared) {
        state.snapshot = undefined;
        if (state.connIds.size === 0) {
          state.cacheLifetime.abort(null);
          keyStates.delete(key);
        }
        invalidated.push(state.target.params);
      }
    }
    if (!("sessionKey" in change)) {
      sessionChanges.emitBatch(
        invalidated.map(({ sessionKey, agentId }) => ({ sessionKey, agentId, scope: "runtime" })),
      );
    }
  });

  return {
    read,
    readPrepared,
    publishSnapshot,
    settle: () => Promise.allSettled(preparing.values()),
    stop: unsubscribeFacts,
  };
}
