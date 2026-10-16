// Serializes lifecycle mutations and work admission for logical session identities.
import { AsyncLocalStorage } from "node:async_hooks";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  bindGatewayContextResolver,
  hasGatewayContextOwner,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  GatewayDrainingError,
  isGatewaySubordinateWorkAdmissionClosed,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners } from "../shared/listeners.js";
import type { StoreWriterQueue } from "../shared/store-writer-queue.js";
import { readAgentDeletionJournalStatusInWorker } from "../state/agent-deletion-journal.read.js";
import {
  agentWorkAdmissionIdentity,
  createAgentWorkAdmissionQueries,
  interruptSessionWorkAdmissionOwners,
  matchesAgentWorkAdmission,
  sessionWorkAdmissionClosures as SESSION_WORK_ADMISSION_CLOSURES,
  type AgentWorkAdmissionIdentity,
} from "./session-agent-work-admission.js";
import {
  createLifecycleDiagnosticOperation,
  type SessionLifecycleMutationOperation,
} from "./session-lifecycle-diagnostics.js";
import {
  collectSessionIdentityTargets,
  normalizeSessionIdentities,
} from "./session-lifecycle-identity.js";
import { createSessionIdentityLockRunner } from "./session-lifecycle-locks.js";
import {
  clearSessionWorkAdmissionHandoffs,
  createSessionWorkAdmissionHandoff,
  type HandoffSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "./session-work-admission-handoff.js";
import {
  sessionWorkAdmissionAbortError,
  waitForSessionWorkAdmissionRelease,
  type SessionWorkAdmissionInterrupt,
} from "./session-work-admission-interruption.js";
import {
  createSessionWorkAdmissionQueries,
  type SessionWorkRun,
} from "./session-work-admission-queries.js";

export {
  cancelSessionWorkAdmissionHandoff,
  consumeSessionWorkAdmissionHandoff,
  type SessionWorkAdmissionLease,
} from "./session-work-admission-handoff.js";
export {
  waitForSessionWorkAdmissionRelease,
  type SessionWorkAdmissionInterrupt,
} from "./session-work-admission-interruption.js";

export const SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS = 15_000;
type SessionWorkAdmission = HandoffSessionWorkAdmission & {
  agent?: AgentWorkAdmissionIdentity;
  run?: SessionWorkRun;
  phase: "pending" | "acquired";
  owner?: symbol;
  released: Promise<void>;
};

type SessionLifecycleMutationOwner = {
  identities: readonly string[];
  kind?: SessionLifecycleMutationKind;
};

type SessionLifecycleAdmissionState = {
  lifecycleQueues: Map<string, StoreWriterQueue>;
  mutationQueues: Map<string, StoreWriterQueue>;
  activeAdmissions: Map<string, Set<SessionWorkAdmission>>;
  workReleaseListeners: Map<string, Set<() => void>>;
  activeMutationRuns: Set<SessionLifecycleMutationOwner>;
  idleWaiters: Map<string, Set<() => void>>;
  currentAdmissions: AsyncLocalStorage<ReadonlySet<SessionWorkAdmission>>;
};

type SessionLifecycleMutationKind = "compaction";

type SessionLifecycleMutationTarget = {
  scope: string;
  identities: Iterable<string | undefined>;
};

type SessionLifecycleMutationParams<T> = {
  kind?: SessionLifecycleMutationKind;
  prepare?: (owner: { closeWorkAdmissions: (reason: Error) => void }) => Promise<void>;
  finalize?: () => Promise<void>;
  run: () => Promise<T>;
  signal?: AbortSignal;
} & (SessionLifecycleMutationTarget | { targets: Iterable<SessionLifecycleMutationTarget> });

// Runtime chunks can load separate module instances while still coordinating
// the same sessions. One shared state keeps every lock and admission visible.
const SESSION_LIFECYCLE_ADMISSION_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionLifecycleAdmissionState"),
  (): SessionLifecycleAdmissionState => ({
    lifecycleQueues: new Map(),
    mutationQueues: new Map(),
    activeAdmissions: new Map(),
    workReleaseListeners: new Map(),
    activeMutationRuns: new Set(),
    idleWaiters: new Map(),
    currentAdmissions: new AsyncLocalStorage(),
  }),
);
const {
  activeAdmissions: ACTIVE_SESSION_WORK_ADMISSIONS,
  workReleaseListeners: SESSION_WORK_RELEASE_LISTENERS,
  activeMutationRuns: ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS,
  idleWaiters: SESSION_LIFECYCLE_IDLE_WAITERS,
  currentAdmissions: CURRENT_SESSION_WORK_ADMISSIONS,
} = SESSION_LIFECYCLE_ADMISSION_STATE;
const {
  collectSessionWorkAdmissions,
  collectActiveSessionWorkAdmissions,
  captureSessionWorkRunInterruptions,
  captureGatewaySessionWorkAdmissions,
  getActiveSessionWorkAdmissionCount,
  getSessionWorkAdmissionRelease,
  getSessionWorkAdmissionOwnerRelease,
  getCompetingSessionWorkAdmissionRelease,
  getTerminalSessionWorkAdmissionRelease,
  isSessionWorkAdmissionActive,
  isCompetingSessionWorkAdmissionActive,
} = createSessionWorkAdmissionQueries<SessionWorkAdmission>(ACTIVE_SESSION_WORK_ADMISSIONS, () =>
  CURRENT_SESSION_WORK_ADMISSIONS.getStore(),
);
export {
  collectActiveSessionWorkAdmissions,
  captureSessionWorkRunInterruptions,
  captureGatewaySessionWorkAdmissions,
  getActiveSessionWorkAdmissionCount,
  getSessionWorkAdmissionRelease,
  getSessionWorkAdmissionOwnerRelease,
  getCompetingSessionWorkAdmissionRelease,
  getTerminalSessionWorkAdmissionRelease,
  isSessionWorkAdmissionActive,
  isCompetingSessionWorkAdmissionActive,
};

const {
  closeAgentWorkAdmissions,
  collectActiveAgentSessionWorkAdmissions,
  startAgentWorkAdmissionInterruption,
  assertSessionWorkAdmissionOpen,
} = createAgentWorkAdmissionQueries(ACTIVE_SESSION_WORK_ADMISSIONS, () =>
  CURRENT_SESSION_WORK_ADMISSIONS.getStore(),
);
export {
  closeAgentWorkAdmissions,
  collectActiveAgentSessionWorkAdmissions,
  startAgentWorkAdmissionInterruption,
};

const runWithSessionIdentityLocks = createSessionIdentityLockRunner(
  SESSION_LIFECYCLE_ADMISSION_STATE,
);

function hasActiveSessionLifecycleMutation(identities: readonly string[]): boolean {
  return [...ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS].some((run) =>
    run.identities.some((identity) => identities.includes(identity)),
  );
}

function hasOnlyActiveSessionLifecycleMutationKind(
  identities: readonly string[],
  kind: SessionLifecycleMutationKind,
): boolean {
  const active = [...ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS].filter((run) =>
    run.identities.some((identity) => identities.includes(identity)),
  );
  return active.length > 0 && active.every((run) => run.kind === kind);
}

async function waitForNormalizedSessionLifecycleMutationIdle(
  identities: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const activeIdentities = identities.filter((identity) =>
    hasActiveSessionLifecycleMutation([identity]),
  );
  if (activeIdentities.length === 0) {
    return;
  }
  signal?.throwIfAborted();
  const idle = Promise.all(
    activeIdentities.map(
      (identity) =>
        new Promise<void>((resolve) => {
          const waiters = SESSION_LIFECYCLE_IDLE_WAITERS.get(identity) ?? new Set();
          waiters.add(resolve);
          SESSION_LIFECYCLE_IDLE_WAITERS.set(identity, waiters);
        }),
    ),
  );
  await racePromiseWithAbortSignal(idle, signal, sessionWorkAdmissionAbortError);
}

async function runExclusiveSessionLifecycle<T>(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  const identities = normalizeSessionIdentities(params.scope, params.identities);
  while (true) {
    params.signal?.throwIfAborted();
    if (hasActiveSessionLifecycleMutation(identities)) {
      await waitForNormalizedSessionLifecycleMutationIdle(identities, params.signal);
      continue;
    }
    const diagnostic = createLifecycleDiagnosticOperation("lifecycle", identities, params.signal);
    const attempt = await runWithSessionIdentityLocks(
      identities,
      async () => {
        params.signal?.throwIfAborted();
        if (hasActiveSessionLifecycleMutation(identities)) {
          return { blocked: true as const };
        }
        return { blocked: false as const, value: await params.run() };
      },
      diagnostic,
      "run",
    );
    if (!attempt.blocked) {
      return attempt.value;
    }
    await waitForNormalizedSessionLifecycleMutationIdle(identities, params.signal);
  }
}

export async function runExclusiveSessionLifecycleMutation<T>(
  operation: SessionLifecycleMutationOperation,
  params: SessionLifecycleMutationParams<T>,
): Promise<T> {
  // Normalize every store and session into one globally ordered identity set.
  // Cross-agent mutations then acquire one fence and count as one active run,
  // instead of nesting store locks in caller-selected order.
  const identities =
    "targets" in params
      ? Array.from(
          new Set(
            Array.from(params.targets, (target) =>
              normalizeSessionIdentities(target.scope, target.identities),
            ).flat(),
          ),
        ).toSorted()
      : normalizeSessionIdentities(params.scope, params.identities);
  const signal = params.signal;
  signal?.throwIfAborted();
  const callerAdmissions = new Set(CURRENT_SESSION_WORK_ADMISSIONS.getStore());
  const diagnostic = createLifecycleDiagnosticOperation(
    params.kind ?? "mutation",
    identities,
    signal,
    operation,
  );
  const mutationRun: SessionLifecycleMutationOwner = { identities, kind: params.kind };
  let mutationActivated = false;
  let removeAbortListener = () => {};
  let releaseWorkAdmissions: (() => void) | undefined;
  const mutation = runWithSessionIdentityLocks(
    identities,
    async () =>
      await CURRENT_SESSION_WORK_ADMISSIONS.run(callerAdmissions, async () => {
        await runWithSessionIdentityLocks(
          identities,
          async () => {
            signal?.throwIfAborted();
            mutationActivated = true;
            removeAbortListener();
            ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS.add(mutationRun);
          },
          diagnostic,
        );
        // Cancellation may abandon a queued contender, but never an active
        // mutation whose caller must observe cleanup and completion.
        try {
          diagnostic?.mark("prepare");
          await params.prepare?.({
            // The same mutation owner fences ingress through every awaited cleanup step.
            // Removing this owner below reopens admission for an explicit later request.
            closeWorkAdmissions: (reason) => {
              releaseWorkAdmissions?.();
              releaseWorkAdmissions = closeNormalizedSessionWorkAdmissions(identities, reason);
            },
          });
          diagnostic?.mark("run-admission");
          return await runWithSessionIdentityLocks(identities, params.run, diagnostic, "run");
        } finally {
          // Resource finalization is part of the mutation: successors remain
          // fenced until rollback or exact-generation cleanup has completed.
          try {
            diagnostic?.mark("finalize");
            await params.finalize?.();
          } finally {
            diagnostic?.mark("release");
            await runWithSessionIdentityLocks(
              identities,
              async () => {
                ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS.delete(mutationRun);
                for (const identity of identities) {
                  if (hasActiveSessionLifecycleMutation([identity])) {
                    continue;
                  }
                  const waiters = SESSION_LIFECYCLE_IDLE_WAITERS.get(identity);
                  SESSION_LIFECYCLE_IDLE_WAITERS.delete(identity);
                  for (const resolve of waiters ?? []) {
                    resolve();
                  }
                }
                releaseWorkAdmissions?.();
              },
              diagnostic,
            );
          }
        }
      }),
    diagnostic,
    "activation",
    "mutation",
  );
  if (!signal || mutationActivated) {
    return await mutation;
  }
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      if (mutationActivated) {
        return;
      }
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  try {
    return await Promise.race([mutation, aborted]);
  } finally {
    removeAbortListener();
  }
}

export function isSessionLifecycleMutationActive(
  scope: string,
  identities: Iterable<string | undefined>,
): boolean {
  return hasActiveSessionLifecycleMutation(normalizeSessionIdentities(scope, identities));
}

export function hasOnlySessionLifecycleMutationKindActive(
  scope: string,
  identities: Iterable<string | undefined>,
  kind: SessionLifecycleMutationKind,
): boolean {
  return hasOnlyActiveSessionLifecycleMutationKind(
    normalizeSessionIdentities(scope, identities),
    kind,
  );
}

/** Unique active lifecycle mutations; one run can be indexed under several identities. */
export function getActiveSessionLifecycleMutationCount(): number {
  return ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS.size;
}

/** Snapshot the existing lifecycle identity index for off-thread maintenance planning. */
export function collectActiveSessionLifecycleMutationIdentities(scope: string): string[] {
  const identities = [...ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS].flatMap((run) => run.identities);
  return [...(collectSessionIdentityTargets(identities).get(scope.trim()) ?? [])].toSorted();
}

/** Observe acquired protection disappearing, independently of terminal row publication. */
export function observeSessionWorkAdmissionReleases(
  scope: string,
  listener: () => void,
): () => void {
  const key = scope.trim();
  const listeners = SESSION_WORK_RELEASE_LISTENERS.get(key) ?? new Set();
  listeners.add(listener);
  SESSION_WORK_RELEASE_LISTENERS.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && SESSION_WORK_RELEASE_LISTENERS.get(key) === listeners) {
      SESSION_WORK_RELEASE_LISTENERS.delete(key);
    }
  };
}

/** Accepted independent executions retain their own leases, not their caller's nested-work exemption. */
export function runWithoutInheritedSessionWorkAdmissions<T>(run: () => T): T {
  return CURRENT_SESSION_WORK_ADMISSIONS.exit(run);
}

export async function beginSessionWorkAdmission(params: {
  agentId?: string;
  statePath?: string;
  env?: NodeJS.ProcessEnv;
  scope: string;
  identities: Iterable<string | undefined>;
  /** Only an execution owner returning an exact interruption receipt for this runId may declare it. */
  run?: SessionWorkRun;
  /** Complete store keys read or written by final validation; omission keeps a store-wide barrier. */
  storeWriterIdentities?: Iterable<string | undefined>;
  /** Stable process-wide identity for owners that must be observable while still pending. */
  owner?: symbol;
  /** The execution owner has committed its terminal outcome; cleanup still retains this lease. */
  isSettling?: () => boolean;
  /** Borrow the execution owner's current abort reason, including after admission handoff. */
  getAbortReason?: () => unknown;
  /** Queue behind earlier admissions of the same owner, including pending work. */
  serializeOwner?: boolean;
  resolveGatewayContext?: GatewayContextResolver;
  assertAllowed?: (signal: AbortSignal) => Promise<void> | void;
  /** Final writer-ordered validation; use when one-time effects must not run during the first check. */
  revalidateAllowed?: () => Promise<void> | void;
  onInterrupt?: SessionWorkAdmissionInterrupt;
  signal?: AbortSignal;
}): Promise<SessionWorkAdmissionLease> {
  if (isGatewaySubordinateWorkAdmissionClosed()) {
    throw new GatewayDrainingError();
  }
  const rawIdentities = Array.from(params.identities);
  const agent = params.agentId
    ? agentWorkAdmissionIdentity({ ...params, agentId: params.agentId })
    : undefined;
  // An adopted unbound owner must not inherit the adopting request's Gateway.
  const resolveGatewayContext = Object.hasOwn(params, "resolveGatewayContext")
    ? params.resolveGatewayContext
    : getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const identities = normalizeSessionIdentities(params.scope, rawIdentities);
  const inheritedAdmissions = CURRENT_SESSION_WORK_ADMISSIONS.getStore();
  const predecessors =
    params.serializeOwner && params.owner
      ? collectSessionWorkAdmissions(identities, (admission) => admission.owner === params.owner)
      : new Set<SessionWorkAdmission>();
  // A queued successor also waits on the current owner; nested work must not join it.
  if (
    Array.from(predecessors).some(
      (admission) =>
        inheritedAdmissions?.has(admission) &&
        identities.every((identity) => admission.identities.has(identity)),
    )
  ) {
    predecessors.clear();
  }
  const pendingController = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, pendingController.signal])
    : pendingController.signal;
  let writerBarrierStarted = false;
  const { promise: releasedPromise, resolve: resolveReleased } = createDeferredCore();
  const admission: SessionWorkAdmission = {
    agent,
    run: params.run ? Object.freeze({ ...params.run }) : undefined,
    phase: "pending",
    isSettling: params.isSettling,
    getAbortReason: params.getAbortReason ?? (() => signal.reason),
    ...(params.owner ? { owner: params.owner } : {}),
    handoffIds: new Set(),
    identities: new Set(identities),
    interrupted: undefined,
    interrupt: (reason) => {
      admission.interrupted ??= reason ?? new Error("Session work admission interrupted");
      try {
        return params.onInterrupt?.(admission.interrupted);
      } finally {
        pendingController.abort(admission.interrupted);
      }
    },
    released: releasedPromise,
  };
  bindGatewayContextResolver(admission, resolveGatewayContext);
  // Reserve before waiting: Stop must own queued ingress as well as running work.
  for (const identity of identities) {
    const active = ACTIVE_SESSION_WORK_ADMISSIONS.get(identity) ?? new Set();
    active.add(admission);
    ACTIVE_SESSION_WORK_ADMISSIONS.set(identity, active);
  }
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    const listeners = SESSION_WORK_RELEASE_LISTENERS.get(params.scope.trim());
    let protectionReleased = false;
    for (const identity of identities) {
      const active = ACTIVE_SESSION_WORK_ADMISSIONS.get(identity);
      active?.delete(admission);
      if (!active?.size) {
        ACTIVE_SESSION_WORK_ADMISSIONS.delete(identity);
      }
      if (
        listeners?.size &&
        admission.phase === "acquired" &&
        ![...(active ?? [])].some((other) => other.phase === "acquired")
      ) {
        protectionReleased = true;
      }
    }
    clearSessionWorkAdmissionHandoffs(admission);
    resolveReleased();
    if (protectionReleased) {
      notifyListeners(listeners ?? [], undefined);
    }
  };
  const lease: SessionWorkAdmissionLease = {
    isActive: () => !released,
    createHandoff: () => {
      if (released) {
        throw new Error("cannot hand off a released session work admission");
      }
      return createSessionWorkAdmissionHandoff(admission, lease);
    },
    release,
    released: admission.released,
    run: async <T>(run: () => Promise<T>) => {
      const current = new Set(CURRENT_SESSION_WORK_ADMISSIONS.getStore());
      current.add(admission);
      return await CURRENT_SESSION_WORK_ADMISSIONS.run(current, () =>
        withPluginRuntimeGatewayContextResolver(resolveGatewayContext, run),
      );
    },
  };
  let removeAbortListener = () => {};
  const assertIngressOpen = () => {
    assertSessionWorkAdmissionOpen(admission);
    signal.throwIfAborted();
  };
  const assertAgentIngressOpen = async () => {
    assertIngressOpen();
    if (agent) {
      const journal = await readAgentDeletionJournalStatusInWorker(
        agent.agentId,
        { path: agent.statePath, env: params.env },
        signal,
      );
      if (journal !== "absent") {
        throw new Error(`Agent ${agent.agentId} deletion is in progress; new work is unavailable.`);
      }
    }
    assertIngressOpen();
  };
  try {
    await assertAgentIngressOpen();
    if (predecessors.size > 0) {
      await racePromiseWithAbortSignal(
        Promise.all(Array.from(predecessors, (predecessor) => predecessor.released)),
        signal,
        sessionWorkAdmissionAbortError,
      );
    }
    const queuedAbort = new Promise<never>((_, reject) => {
      const onAbort = () => {
        if (!writerBarrierStarted) {
          reject(sessionWorkAdmissionAbortError(signal));
        }
      };
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
    const acquired = runExclusiveSessionLifecycle({
      scope: params.scope,
      identities: rawIdentities,
      signal,
      run: async () => {
        if (params.revalidateAllowed && params.assertAllowed) {
          await lease.run(async () => await params.assertAllowed?.(signal));
        }
        assertIngressOpen();
        if (isGatewaySubordinateWorkAdmissionClosed()) {
          throw new GatewayDrainingError();
        }
        if (params.revalidateAllowed) {
          admission.phase = "acquired";
        }
        await runExclusiveSessionStoreWrite(
          params.scope,
          async () => {
            writerBarrierStarted = true;
            signal.throwIfAborted();
            assertIngressOpen();
            await lease.run(async () => {
              if (params.revalidateAllowed) {
                await params.revalidateAllowed();
              } else {
                await params.assertAllowed?.(signal);
                admission.phase = "acquired";
              }
            });
            assertIngressOpen();
          },
          { reentrant: true, identities: params.storeWriterIdentities, signal },
        );
        return lease;
      },
    });
    // Queued acquisition may sit behind the mutation's locks. Abort releases only
    // that reservation; a started writer remains owned until its real completion.
    return await Promise.race([acquired, queuedAbort]);
  } catch (error) {
    release();
    throw error;
  } finally {
    removeAbortListener();
  }
}

function closeNormalizedSessionWorkAdmissions(
  identities: readonly string[],
  reason: Error,
  assertCurrent?: () => void,
  agent?: AgentWorkAdmissionIdentity,
) {
  const owner = { identities, reason, agent };
  SESSION_WORK_ADMISSION_CLOSURES.add(owner);
  // Retire queued ingress immediately; acquired runs keep their canonical cancellation owner.
  try {
    startNormalizedSessionWorkAdmissionInterruption({
      identities,
      reason,
      pendingOnly: true,
      assertCurrent,
      agent,
    });
  } catch (error) {
    SESSION_WORK_ADMISSION_CLOSURES.delete(owner);
    throw error;
  }
  return () => {
    SESSION_WORK_ADMISSION_CLOSURES.delete(owner);
  };
}

/** Fence ingress while awaiting cleanup that must run outside lifecycle/placement locks. */
export function closeSessionWorkAdmissions(params: {
  agent?: AgentWorkAdmissionIdentity;
  scope: string;
  identities: Iterable<string | undefined>;
  reason: Error;
  assertCurrent?: () => void;
}): () => void {
  return closeNormalizedSessionWorkAdmissions(
    normalizeSessionIdentities(params.scope, params.identities),
    params.reason,
    params.assertCurrent,
    params.agent,
  );
}

function startNormalizedSessionWorkAdmissionInterruption(params: {
  agent?: AgentWorkAdmissionIdentity;
  reason?: Error;
  identities: readonly string[];
  pendingOnly?: boolean;
  assertCurrent?: () => void;
}): { released: Promise<void>; interruptedRunIds: ReadonlySet<string> } {
  const currentAdmissions = CURRENT_SESSION_WORK_ADMISSIONS.getStore();
  // In-band lifecycle commands suspend their own admitted turn while the
  // mutation runs. Interrupt competing work, not the initiating stack.
  const admissions = collectSessionWorkAdmissions(
    params.identities,
    (admission) =>
      (!params.pendingOnly || admission.phase === "pending") &&
      !currentAdmissions?.has(admission) &&
      (!params.agent || matchesAgentWorkAdmission(params.agent, admission.agent)),
  );
  return interruptSessionWorkAdmissionOwners(admissions, params.reason, params.assertCurrent);
}

export function startSessionWorkAdmissionInterruption(params: {
  agent?: AgentWorkAdmissionIdentity;
  reason?: Error;
  assertCurrent?: () => void;
  scope: string;
  identities: Iterable<string | undefined>;
}): { released: Promise<void>; interruptedRunIds: ReadonlySet<string> } {
  return startNormalizedSessionWorkAdmissionInterruption({
    agent: params.agent,
    identities: normalizeSessionIdentities(params.scope, params.identities),
    reason: params.reason,
    assertCurrent: params.assertCurrent,
  });
}

/** Cancel this Gateway's ingress, retaining acquired custody through physical settlement. */
export function startGatewaySessionWorkAdmissionInterruption(
  resolveGatewayContext: GatewayContextResolver,
  reason: Error,
): { released: Promise<void> } {
  const admissions = collectSessionWorkAdmissions(ACTIVE_SESSION_WORK_ADMISSIONS.keys(), (owner) =>
    hasGatewayContextOwner(owner, resolveGatewayContext),
  );
  const interruptions = Array.from(admissions, (owner) => {
    if (owner.interrupted || owner.isSettling?.()) {
      return owner.released;
    }
    try {
      return interruptSessionWorkAdmissionOwners(new Set([owner]), reason).released;
    } catch (error) {
      // A failed cancellation callback must not strand another owner's ingress.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return {
    released: Promise.allSettled([
      ...interruptions,
      ...Array.from(admissions, (owner) => owner.released),
    ]).then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
    }),
  };
}

export async function interruptSessionWorkAdmissions(params: {
  reason?: Error;
  scope: string;
  identities: Iterable<string | undefined>;
  timeoutMs?: number;
}): Promise<boolean> {
  const { released } = startSessionWorkAdmissionInterruption(params);
  return waitForSessionWorkAdmissionRelease(released, params.timeoutMs);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionLifecycleAdmissionTestApi")
  ] = { runExclusiveSessionLifecycle };
}
