import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import type {
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequests,
} from "./control-ui-contract.js";
import { recordSessionPrDiagnostic } from "./control-ui-session-pr-diagnostics.js";
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
  recordSessionPrDiagnostic("loader-import-started", read.target);
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
  sourceIdentity?: string;
  snapshot?: ControlUiSessionPullRequestSnapshot;
  branchSnapshot?: ControlUiSessionPullRequestSnapshot;
  prepared?: boolean;
  assertReadAuthority?: () => void;
};

export type WatchedKeyState = PreparedSessionPrState & {
  sessionKeysByConnId: Map<string, Set<string>>;
  refreshedAt?: number;
  cancelRefresh?: () => void;
  delivery?: Promise<void>;
};

/** Index each connection's requested keys on the cell that retains its snapshot. */
export function addControlUiSessionPrMembership(
  state: Pick<PreparedSessionPrState, "connIds"> & {
    sessionKeysByConnId: Map<string, Set<string>>;
  },
  connId: string,
  sessionKey: string,
): void {
  let keys = state.sessionKeysByConnId.get(connId);
  if (!keys) {
    keys = new Set();
    state.sessionKeysByConnId.set(connId, keys);
  }
  keys.add(sessionKey);
  state.connIds.add(connId);
}

/** Retire the unused cell through the same owner that retains its prepared readers. */
export function retireControlUiSessionPrState<
  State extends PreparedSessionPrState & { cancelRefresh?: () => void },
>(state: State | undefined, keyStates: Map<string, State>): void {
  if (!state || state.prepared || state.connIds.size > 0) {
    return;
  }
  state.cancelRefresh?.();
  state.cacheLifetime.abort(null);
  if (keyStates.get(state.target.identity) === state) {
    keyStates.delete(state.target.identity);
  }
}

/** Retain only branch facts across audience/mode changes on the same physical source. */
export function retainControlUiSessionPrBranchSnapshot(
  state: PreparedSessionPrState,
  previous: PreparedSessionPrState | undefined,
) {
  if (
    !previous?.target.branchIdentity ||
    previous.target.branchIdentity !== state.target.branchIdentity ||
    previous.target.taskReceipts?.ownerProfileId !== state.target.taskReceipts?.ownerProfileId
  ) {
    return;
  }
  state.sourceIdentity ??= previous.sourceIdentity;
  if (
    state.sourceIdentity === previous.sourceIdentity &&
    previous.branchSnapshot &&
    state.branchSnapshot !== previous.branchSnapshot
  ) {
    state.branchSnapshot = previous.branchSnapshot;
    state.assertReadAuthority = previous.assertReadAuthority;
    state.snapshot = undefined;
  }
}

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
  stateForTarget: (target: ControlUiSessionPrTarget) => State;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
}) {
  const { scope, limit, withSource, load, keyStates, stateForTarget } = deps;
  const spawnBroker = getSpawnBroker();
  const preparing = new Map<State, Promise<void>>();
  const preparedTargets = new Map<string, string>();
  const writeSnapshot = (state: State, snapshot: ControlUiSessionPullRequestSnapshot) => {
    const changed = JSON.stringify(state.snapshot) !== JSON.stringify(snapshot);
    recordSessionPrDiagnostic("snapshot-published", state.target);
    state.snapshot = snapshot;
    if (changed && state.prepared) {
      sessionChanges.emit({
        ...state.target.params,
        scope: "runtime",
      });
    }
  };

  const publishBranchSnapshot = (
    target: ControlUiSessionPrTarget,
    snapshot: ControlUiSessionPullRequestSnapshot,
  ) => {
    if (!target.branchIdentity || target.taskReceiptsOnly) {
      return;
    }
    const state = keyStates.get(target.identity);
    if (state) {
      state.branchSnapshot = snapshot;
    }
    const branchState = keyStates.get(target.branchIdentity);
    if (branchState) {
      writeSnapshot(branchState, snapshot);
    }
  };
  const publishSnapshot = (
    state: State,
    snapshot: ControlUiSessionPullRequestSnapshot,
    assertReadAuthority?: () => void,
  ) => {
    state.assertReadAuthority = assertReadAuthority;
    writeSnapshot(state, snapshot);
    // Branch-only loaders (including injected ones) need no separate projection callback.
    if (!snapshot.taskPullRequests) {
      publishBranchSnapshot(state.target, snapshot);
    }
  };

  const read = (
    target: ControlUiSessionPrTarget,
    assertCurrent: () => void,
    projection?: ControlUiSessionPrReadContext["projection"],
  ): Promise<ControlUiSessionPullRequestSnapshot> => {
    const state = keyStates.get(target.identity);
    const previous = state?.snapshot;
    let assertReadAuthority: (() => void) | undefined;
    const assertActive = () => {
      if (scope.isClosing) {
        throw new Error("Session pull-request owner is closed");
      }
      assertCurrent();
      target.assertCurrent?.();
      assertReadAuthority?.();
    };
    const publish = (snapshot: ControlUiSessionPullRequestSnapshot) => {
      // A retry may replace stale facts, but never a newer watcher publication.
      if (
        projection !== "publication" &&
        state?.prepared &&
        keyStates.get(target.identity) === state &&
        state.snapshot === previous &&
        state.target.identity === target.identity
      ) {
        publishSnapshot(state, snapshot, assertReadAuthority);
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
              onBranchRead: (branch) => {
                assertReadCurrent();
                publishBranchSnapshot(target, pushedSnapshot(branch));
              },
              assertCurrent: assertReadCurrent,
              retainReadAuthority: (guard) => {
                assertReadAuthority = guard;
              },
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
    const session = JSON.stringify([target.params.agentId, target.params.sessionKey]);
    const previousIdentity = preparedTargets.get(session);
    if (previousIdentity && previousIdentity !== target.identity) {
      const previous = keyStates.get(previousIdentity);
      if (previous) {
        previous.prepared = false;
        if (previous.connIds.size === 0) {
          previous.cacheLifetime.abort(null);
          keyStates.delete(previousIdentity);
        }
      }
    }
    preparedTargets.set(session, target.identity);
    const state = stateForTarget(target);
    const preparedTarget = state.target;
    state.prepared = true;
    // Bootstrap a cold service cell from an active viewer's branch-only publication.
    // Later viewer refreshes update this cell directly; audience/task fields never cross.
    if (!state.snapshot) {
      for (const candidate of keyStates.values()) {
        if (candidate.target.branchIdentity === target.identity && candidate.branchSnapshot) {
          state.snapshot = candidate.branchSnapshot;
          break;
        }
      }
    }
    if (target.source === null && !target.githubPullRequest) {
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
        // Keep the Gateway's process owner without reviving the requesting caller's context.
        runWithSpawnBroker(spawnBroker, () =>
          scope.track(async () => {
            const current = await limit(async () => {
              if (scope.isClosing || keyStates.get(preparedTarget.identity) !== state) {
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
                keyStates.get(preparedTarget.identity) !== state ||
                current.identity !== preparedTarget.identity
              ) {
                throw new Error("Prepared session pull-request target changed");
              }
              current.assertCurrent?.();
            };
            assertCurrent();
            await read(current, assertCurrent);
          }),
        ),
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
        ? [...keyStates].filter(([, state]) => state.target.params.sessionKey === change.sessionKey)
        : keyStates;
    const invalidated: Array<ControlUiSessionPrTarget["params"]> = [];
    for (const [key, state] of affected) {
      state.branchSnapshot = undefined;
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
    publishBranchSnapshot,
    settle: () => Promise.allSettled(preparing.values()),
    stop: unsubscribeFacts,
  };
}
