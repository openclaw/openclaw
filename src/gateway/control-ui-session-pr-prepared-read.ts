import { sessionChanges } from "../sessions/session-row-changes.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import type { ControlUiSessionPullRequestSnapshot } from "./control-ui-contract.js";
import {
  prepareControlUiSessionPrServiceTarget,
  type ControlUiSessionPrTarget,
} from "./control-ui-session-pr-read.js";
import { createControlUiSessionPrSnapshotRead } from "./control-ui-session-pr-snapshot-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";

export type PreparedSessionPrState = {
  connIds: Set<string>;
  target: ControlUiSessionPrTarget;
  cacheLifetime: AbortController;
  snapshot?: ControlUiSessionPullRequestSnapshot;
  prepared?: boolean;
};

/** Background readers publish into the subscription owner's existing cells and concurrency. */
export function createControlUiSessionPrPreparedRead<State extends PreparedSessionPrState>(
  deps: Omit<Parameters<typeof createControlUiSessionPrSnapshotRead>[0], "publish"> & {
    keyStates: Map<string, State>;
    stateForTarget: (sessionKey: string, target: ControlUiSessionPrTarget) => State;
    getSessionRowProjection?: () => SessionRowProjection | undefined;
  },
) {
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

  const read = createControlUiSessionPrSnapshotRead({
    scope,
    limit,
    withSource,
    load,
    publish: (target, snapshot) => {
      const state = keyStates.get(target.params.sessionKey);
      if (
        state?.prepared &&
        state.snapshot === undefined &&
        state.target.identity === target.identity
      ) {
        publishSnapshot(state, snapshot);
      }
    },
  });
  const readPrepared = (target: ControlUiSessionPrTarget) => {
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
    if (!state.snapshot && !preparing.has(state) && getProjection) {
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
