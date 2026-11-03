import type { OpenClawConfig } from "../plugin-sdk/core.js";
import type {
  NativeGitHubSessionReads as RepositorySessionReads,
  RepositorySessionSourceScope,
  PreparedNativeGitHubSessionRead as PreparedRepositorySessionRead,
} from "../plugin-sdk/native-github-session-read.js";
import type { OpenClawPluginServiceContextV2 } from "../plugin-sdk/plugin-entry.js";
import { isIncognitoSessionKey } from "../plugin-sdk/session-key-runtime.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
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
  type ControlUiSessionPrRead,
  type ControlUiSessionPrReadContext,
} from "./control-ui-session-pr-target.js";
import type { ControlUiSessionPullRequestsParams } from "./control-ui-session-prs.js";
const receiptsOnlyTargetIdentity = (identity: string) =>
  JSON.stringify([identity, "receipts-only"]);

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

type SchedulerScope = Pick<
  OpenClawPluginServiceContextV2["scheduler"],
  "signal" | "now" | "schedule" | "beginClose" | "stop"
>;
export type SessionPrScheduler = SchedulerScope & { scope: () => SchedulerScope };

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

export type WatchedSessionPr = {
  readCurrent: ControlUiSessionPrRead;
  target: ControlUiSessionPrTarget;
  deliveredHash?: string;
  refreshPending?: boolean;
};

/** Acquire through the actual prepared viewer; cached observations never carry private authority. */
export function createControlUiSessionPrSourceRead(deps: {
  reads: Pick<RepositorySessionReads, "withSource">;
  keyStates: ReadonlyMap<string, WatchedKeyState>;
  currentWatcher: (
    connId: string,
    sessionKey: string,
  ) => Promise<{ target: ControlUiSessionPrTarget } | undefined>;
}) {
  return async <T>(
    target: ControlUiSessionPrTarget,
    operation: (
      assertCurrent: () => void,
      sourceIdentity: string,
      sourceScope: RepositorySessionSourceScope,
      selectedRead?: PreparedRepositorySessionRead,
    ) => Promise<T>,
  ) => {
    const run = (source: RepositorySessionSourceScope) =>
      operation(source.assertCurrent, source.identity, source, target.read);
    if (target.read) {
      return await target.read.withSource(run);
    }
    if (!isIncognitoSessionKey(target.params.sessionKey) && !target.ownGitHubProfileId) {
      if (!target.includesTaskPublications) {
        return await deps.reads.withSource(target.observation, run);
      }
      const withViewer = async <Result>(
        use: (read: PreparedRepositorySessionRead) => Promise<Result>,
      ): Promise<Result> => {
        const state = deps.keyStates.get(target.identity);
        for (const [connId, keys] of state?.sessionKeysByConnId ?? []) {
          for (const key of Array.from(keys)) {
            state?.cacheLifetime.signal.throwIfAborted();
            const watched = await deps.currentWatcher(connId, key);
            const read = watched?.target.read;
            if (!read || watched.target.identity !== target.identity) {
              continue;
            }
            try {
              return await use(read);
            } catch (error) {
              try {
                read.assertCurrent();
              } catch {
                continue;
              }
              throw error;
            }
          }
        }
        throw new Error("Session pull-request watchers changed");
      };
      const selected = await withViewer(async (read) => read);
      return await deps.reads.withSource(target.observation, (source) =>
        operation(source.assertCurrent, source.identity, source, {
          ...selected,
          readTaskPublications: (input, signal) =>
            withViewer((read) => read.readTaskPublications(input, signal)),
        }),
      );
    }

    // Private sources require a live viewer; observations never grant background access.
    const state = deps.keyStates.get(target.identity);
    if (state) {
      for (const [connId, keys] of state.sessionKeysByConnId) {
        const sessionKeys = Array.from(keys);
        for (const key of sessionKeys) {
          state.cacheLifetime.signal.throwIfAborted();
          const watched = await deps.currentWatcher(connId, key);
          const read = watched?.target.read;
          if (!read || watched.target.identity !== target.identity) {
            continue;
          }
          try {
            return await read.withSource((source) =>
              operation(source.assertCurrent, source.identity, source, read),
            );
          } catch (error) {
            try {
              read.assertCurrent();
            } catch {
              // A departing viewer can hand this read-only load to another current viewer.
              continue;
            }
            throw error;
          }
        }
      }
    }
    throw new Error("Session pull-request watchers changed");
  };
}

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
function retireControlUiSessionPrState<
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

export function removeControlUiSessionPrMembership(
  state: WatchedKeyState | undefined,
  connId: string,
  sessionKey: string,
  keyStates: Map<string, WatchedKeyState>,
): void {
  const keys = state?.sessionKeysByConnId.get(connId);
  keys?.delete(sessionKey);
  if (keys?.size === 0) {
    state?.sessionKeysByConnId.delete(connId);
    state?.connIds.delete(connId);
  }
  retireControlUiSessionPrState(state, keyStates);
}

// The verified states each passive cell last reloaded for; a cache miss never retries per poll.
const passiveReloads = new WeakMap<PreparedSessionPrState, string>();

/**
 * A full read verified task PR states that its watched receipt-only sibling still lacks.
 * Reloading that sibling reuses the verified metadata cache and never starts a GitHub read.
 */
export function staleReceiptsOnlyCell(
  keyStates: ReadonlyMap<string, PreparedSessionPrState>,
  state: PreparedSessionPrState,
  snapshot: ControlUiSessionPullRequestSnapshot,
): string | undefined {
  if (state.target.taskReceiptsOnly) {
    return undefined;
  }
  const passiveKey = receiptsOnlyTargetIdentity(state.target.identity);
  const passive = keyStates.get(passiveKey);
  const verified = new Map(
    snapshot.taskPullRequests?.flatMap((task) =>
      task.pullRequest ? [[task.url, task.pullRequest.state] as const] : [],
    ),
  );
  if (
    !passive?.connIds.size ||
    !passive.snapshot?.taskPullRequests?.some(
      (task) => verified.has(task.url) && task.pullRequest?.state !== verified.get(task.url),
    )
  ) {
    return undefined;
  }
  const signature = JSON.stringify([...verified]);
  if (passiveReloads.get(passive) === signature) {
    return undefined;
  }
  passiveReloads.set(passive, signature);
  return passiveKey;
}

/** Retain only branch facts across audience/mode changes on the same physical source. */
export function retainControlUiSessionPrBranchSnapshot(
  state: PreparedSessionPrState,
  previous: PreparedSessionPrState | undefined,
) {
  if (
    !previous?.target.branchIdentity ||
    previous.target.branchIdentity !== state.target.branchIdentity ||
    previous.target.taskAudienceKey !== state.target.taskAudienceKey
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
    operation: (
      assertCurrent: () => void,
      sourceIdentity: string,
      sourceScope: RepositorySessionSourceScope,
      selectedRead?: PreparedRepositorySessionRead,
    ) => Promise<T>,
  ) => Promise<T>;
  load: (
    params: ControlUiSessionPullRequestsParams,
    cacheSignal: AbortSignal | undefined,
    read: ControlUiSessionPrReadContext,
  ) => Promise<ControlUiSessionPullRequests>;
  keyStates: Map<string, State>;
  stateForTarget: (target: ControlUiSessionPrTarget) => State;
  reads: RepositorySessionReads;
  getConfig: () => OpenClawConfig;
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
      deps.reads.invalidate(state.target.params);
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
        return await withSource(
          target,
          async (assertSourceCurrent, sourceIdentity, sourceScope, selectedRead) => {
            const assertReadCurrent = () => {
              assertActive();
              assertSourceCurrent();
            };
            assertReadCurrent();
            try {
              const result = await load(target.params, undefined, {
                target: selectedRead ? { ...target, read: selectedRead } : target,
                sourceIdentity,
                sourceScope,
                readTaskPublications: selectedRead?.readTaskPublications,
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
              return UNAVAILABLE_SNAPSHOT;
            }
          },
        );
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
    if (
      (!state.snapshot || state.snapshot.status !== "ready" || state.snapshot.rateLimited) &&
      !preparing.has(state) &&
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
                deps.reads,
                deps.getConfig,
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

  const unsubscribeFacts = deps.reads.subscribeChanges((change) => {
    if (change.kind === "publications") {
      return;
    }
    const affected =
      change.kind === "session"
        ? [...keyStates].filter(([, state]) => state.target.params.sessionKey === change.sessionKey)
        : keyStates;
    const invalidated: Array<ControlUiSessionPrTarget["params"]> = [];
    for (const [key, state] of affected) {
      state.branchSnapshot = undefined;
      if (state.prepared) {
        state.snapshot = undefined;
        if (state.connIds.size === 0) {
          state.cacheLifetime.abort(null);
          keyStates.delete(key);
        }
        invalidated.push(state.target.params);
      }
    }
    if (change.kind !== "session") {
      for (const query of invalidated) {
        deps.reads.invalidate(query);
      }
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
