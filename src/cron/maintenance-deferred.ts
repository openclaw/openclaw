// Process-global FIFO queue of cron jobs deferred by the maintenance window.
//
// Each entry records when a job was first blocked by the maintenance phase and
// when it was most-recently blocked. When the phase returns to normal, the
// gateway calls `drainMaintenanceDeferralsOnPhaseExit` to pop entries in FIFO
// order so the cron service can re-evaluate each job through its normal
// admission path (no concurrent replay).
//
// The queue is process-local, mirroring `src/cron/active-jobs.ts` semantics.
// This is intentional: cross-process replay belongs in the durable cron store,
// not in an in-memory queue. The deferred entries here are advisory — the
// authoritative "did this job get a chance to run" state lives in the job's
// persisted schedule revision.
//
// Tests reset state via `resetMaintenanceDeferrals` (see test-support exports
// below) to keep vitest shards isolated.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const MAINTENANCE_DEFERRED_KEY = Symbol.for("openclaw.cron.maintenanceDeferred");

export type MaintenanceDeferredJob = {
  jobId: string;
  agentId: string;
  /** First wall-clock instant the job was blocked by maintenance. */
  firstDeferredAtMs: number;
  /** Most-recent deferred instant; refreshed on each consecutive block. */
  lastDeferredAtMs: number;
  /** Stable id used to deduplicate within a single phase. */
  phaseId: string;
};

type MaintenanceDeferredState = {
  /** FIFO of job ids; first item is the oldest. */
  order: string[];
  /** O(1) lookup table keyed by jobId. */
  byJobId: Map<string, MaintenanceDeferredJob>;
  /** The id of the currently-active maintenance phase. New defers reuse it. */
  activePhaseId: string | null;
  /** Monotonic phase counter; bumped each time maintenance re-activates. */
  nextPhaseSeq: number;
  /** Waiters notified when the queue empties. */
  emptyWaiters: Set<() => void>;
};

function getMaintenanceDeferredState(): MaintenanceDeferredState {
  const state = resolveGlobalSingleton<MaintenanceDeferredState>(MAINTENANCE_DEFERRED_KEY, () => ({
    order: [],
    byJobId: new Map(),
    activePhaseId: null,
    nextPhaseSeq: 1,
    emptyWaiters: new Set(),
  }));
  state.order ??= [];
  state.byJobId ??= new Map();
  state.activePhaseId ??= null;
  state.nextPhaseSeq ??= 1;
  state.emptyWaiters ??= new Set();
  return state;
}

function notifyEmptyWaiters(state: MaintenanceDeferredState) {
  if (state.order.length > 0) {
    return;
  }
  for (const resolve of state.emptyWaiters) {
    resolve();
  }
  state.emptyWaiters.clear();
}

/**
 * Record that a cron job was blocked by the maintenance phase at `nowMs`.
 * If the job is already in the queue, refresh its `lastDeferredAtMs`. The
 * `activePhaseId` is bound to the first deferral of the current phase so the
 * drainer can tell "this entry belongs to the phase that just ended" apart
 * from "this entry is from a previous phase that has not been replayed yet"
 * — replay always replays the entire backlog.
 */
export function recordMaintenanceDeferral(params: {
  jobId: string;
  agentId: string;
  nowMs: number;
}): void {
  if (!params.jobId) {
    return;
  }
  const state = getMaintenanceDeferredState();
  if (state.activePhaseId === null) {
    state.activePhaseId = `phase-${state.nextPhaseSeq++}-${params.nowMs}`;
  }
  const existing = state.byJobId.get(params.jobId);
  if (existing) {
    existing.lastDeferredAtMs = params.nowMs;
    return;
  }
  const entry: MaintenanceDeferredJob = {
    jobId: params.jobId,
    agentId: params.agentId,
    firstDeferredAtMs: params.nowMs,
    lastDeferredAtMs: params.nowMs,
    phaseId: state.activePhaseId,
  };
  state.order.push(params.jobId);
  state.byJobId.set(params.jobId, entry);
}

/**
 * Pop the next FIFO jobId off the queue and return its entry. Returns
 * `undefined` when the queue is empty.
 */
export function shiftMaintenanceDeferral(): MaintenanceDeferredJob | undefined {
  const state = getMaintenanceDeferredState();
  const next = state.order.shift();
  if (!next) {
    return undefined;
  }
  const entry = state.byJobId.get(next);
  state.byJobId.delete(next);
  if (state.order.length === 0) {
    notifyEmptyWaiters(state);
  }
  return entry;
}

/** Peek the full backlog (oldest first) without mutating it. */
export function listMaintenanceDeferrals(): readonly MaintenanceDeferredJob[] {
  const state = getMaintenanceDeferredState();
  const out: MaintenanceDeferredJob[] = [];
  for (const jobId of state.order) {
    const entry = state.byJobId.get(jobId);
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}

/** Returns the number of currently-deferred jobs. */
export function getMaintenanceDeferralCount(): number {
  return getMaintenanceDeferredState().order.length;
}

/**
 * Clear the deferred backlog *and* retire the active phase id. Call this when
 * the maintenance phase exits so the next phase starts from a clean slate.
 * The replayed jobs themselves are popped via `shiftMaintenanceDeferral` by
 * the gateway before this is called.
 */
export function clearMaintenanceDeferrals(): void {
  const state = getMaintenanceDeferredState();
  state.order.length = 0;
  state.byJobId.clear();
  state.activePhaseId = null;
  notifyEmptyWaiters(state);
}

/**
 * Mark that the maintenance phase has just re-activated. Bumps the phase
 * counter; subsequent defers bind to the new id. Does NOT clear the backlog —
 * backlog is only cleared on phase exit via `clearMaintenanceDeferrals`.
 */
export function beginMaintenancePhase(nowMs: number): string {
  const state = getMaintenanceDeferredState();
  const id = `phase-${state.nextPhaseSeq++}-${nowMs}`;
  state.activePhaseId = id;
  return id;
}

/**
 * Resolve once the deferred queue is empty or after `timeoutMs` elapses.
 * Used by the gateway when shutting down to make sure no deferred jobs are
 * left in limbo.
 */
export async function waitForMaintenanceDeferralsToDrain(timeoutMs: number): Promise<{
  drained: boolean;
  pending: number;
}> {
  const state = getMaintenanceDeferredState();
  if (state.order.length === 0) {
    return { drained: true, pending: 0 };
  }
  await new Promise<void>((resolve) => {
    const waiter = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(
      () => {
        state.emptyWaiters.delete(waiter);
        resolve();
      },
      Math.max(0, Math.floor(timeoutMs)),
    );
    state.emptyWaiters.add(waiter);
  });
  return { drained: state.order.length === 0, pending: state.order.length };
}

// --- test-support --------------------------------------------------------

/**
 * Reset process-global state. Mirrors `resetCronActiveJobs` in
 * `src/cron/active-jobs.ts` and is meant to be called from vitest's
 * `beforeEach` to keep shards isolated. Production code paths should use
 * `clearMaintenanceDeferrals` instead.
 */
export function resetMaintenanceDeferrals(): void {
  const state = getMaintenanceDeferredState();
  state.order.length = 0;
  state.byJobId.clear();
  state.activePhaseId = null;
  state.nextPhaseSeq = 1;
  state.emptyWaiters.clear();
  notifyEmptyWaiters(state);
}
