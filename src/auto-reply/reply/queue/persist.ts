import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../../config/io.js";
import { getRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  hasFollowupQueueEntries,
  listUnreadableFollowupQueueKeys,
  loadFollowupQueueEntries,
  loadFollowupQueueEntry,
  replaceFollowupQueueEntries,
} from "../../../infra/followup-queue-sqlite.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  resolveGlobalMap,
  resolveGlobalSet,
  resolveGlobalSingleton,
} from "../../../shared/global-singleton.js";
import {
  isPersistedQueueEntry,
  toPersistedQueueEntry,
  type PersistedQueueEntry,
} from "./persist-codec.js";
import {
  createRestoreRevalidation,
  isDeliverablePersistedFollowup,
  restorePersistedFollowupQueueEntry,
} from "./persist-restore-entry.js";
import {
  clearFollowupQueueLocalOwnershipForTest,
  isFollowupQueueKeyLocallyOwned,
  isFollowupQueueKeyRestartRetired,
  isIncognitoFollowupQueue,
  markFollowupQueueKeyLocallyOwned,
  persistedQueueEntryCarriesWork,
  resolveFollowupQueueRetainKeys,
} from "./persist-snapshot-policy.js";
import type { FollowupQueueState } from "./types.js";

const FOLLOWUP_QUEUES = resolveGlobalMap<string, FollowupQueueState>(
  Symbol.for("openclaw.followupQueues"),
);

/**
 * Keys of non-empty queues restored from disk on this process start.
 * Entries are removed when kickFollowupDrainIfIdle runs for the route.
 * Production drains restored items after restart when agent-runner enqueues
 * with restartIfIdle=true, or when gateway startup wakes the session.
 *
 * Must be process-wide: restoreFollowupQueues() can run from a bundled copy
 * of this module while Gateway recovery and agent-runner drain mapping run
 * from another copy. A module-local Set would leave those copies empty after
 * the restore-once flag is set.
 */
const restoredPendingDrainKeys = resolveGlobalSet<string>(
  Symbol.for("openclaw.followupQueueRestoredPendingDrainKeys"),
  "close-and-restart",
);

export function peekRestoredPendingDrainKeys(): ReadonlySet<string> {
  return restoredPendingDrainKeys;
}

export function clearRestoredPendingDrainKey(key: string): void {
  restoredPendingDrainKeys.delete(key);
}

function hasRestoredPendingWork(key: string): boolean {
  const queue = FOLLOWUP_QUEUES.get(key);
  return Boolean(
    queue &&
    (queue.items.length > 0 ||
      queue.inFlight.size > 0 ||
      queue.droppedCount > 0 ||
      queue.summarySources.length > 0 ||
      queue.summaryElisions.length > 0),
  );
}

/**
 * Map a heartbeat/reply session key back to a restored follow-up queue key.
 * Isolated heartbeats run under `<base>:heartbeat` while the durable queue
 * remains keyed by `<base>`; strip synthetic `:heartbeat` suffixes until a
 * pending restore key matches.
 */
export function resolveRestoredFollowupQueueRecoveryKey(
  candidates: Array<string | undefined | null>,
): string | undefined {
  if (restoredPendingDrainKeys.size === 0) {
    return undefined;
  }
  for (const raw of candidates) {
    const key = raw?.trim();
    if (key && restoredPendingDrainKeys.has(key)) {
      if (hasRestoredPendingWork(key)) {
        return key;
      }
      restoredPendingDrainKeys.delete(key);
    }
  }
  for (const raw of candidates) {
    let cursor = raw?.trim();
    if (!cursor) {
      continue;
    }
    while (cursor.endsWith(":heartbeat")) {
      cursor = cursor.slice(0, -":heartbeat".length);
      if (!cursor) {
        break;
      }
      if (restoredPendingDrainKeys.has(cursor)) {
        if (hasRestoredPendingWork(cursor)) {
          return cursor;
        }
        restoredPendingDrainKeys.delete(cursor);
      }
    }
  }
  return undefined;
}

/** For testing only — reset the pending-drain set between test cases. */
export function clearRestoredPendingDrainKeysForTest(): void {
  restoredPendingDrainKeys.clear();
}

// Process-wide restore-once flag. restoreFollowupQueues() is called at module
// evaluation; in a bundled/split-runtime layout multiple copies of state.ts can
// evaluate, each calling restore. Without a guard, a second restore could
// overwrite an in-flight FOLLOWUP_QUEUES entry (already draining or carrying a
// newer enqueue), causing replay of an already-delivered prompt or loss of a
// fresh queued item. The flag is set only after SQLite initialization succeeds;
// a transient open/schema failure retries instead of stranding queued work.
// Symbol.for is used directly on globalThis (not via resolveGlobalSingleton) so
// the flag is shared by reference across split runtime chunks — see the note in
// src/shared/global-singleton.ts.
const FOLLOWUP_QUEUES_RESTORED_KEY = Symbol.for("openclaw.followupQueuesRestored");
type FollowupQueuesGlobal = { [FOLLOWUP_QUEUES_RESTORED_KEY]?: boolean };

/**
 * Keys whose rows the last bulk restore could not decode. Restore skips those
 * rows, so their keys stay subject to per-key reconciliation: admission for
 * them is rejected until the row reads, instead of upserting over it.
 */
const unreadableRestoredQueueKeys = resolveGlobalSet<string>(
  Symbol.for("openclaw.followupQueueUnreadableRestoredKeys"),
  "close-and-restart",
);

const MAX_FOLLOWUP_QUEUE_RESTORE_RETRIES = 5;

type FollowupQueueRestoreCoordination = {
  inFlight: boolean;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  listener: (() => void) | undefined;
};

// Restore coordination must share the same process slot as the pending-key
// registry. A second bundled copy that sees the restore-once flag still has
// to observe in-flight retries and the Gateway recovery listener.
const restoreCoordination = resolveGlobalSingleton<FollowupQueueRestoreCoordination>(
  Symbol.for("openclaw.followupQueueRestoreCoordination"),
  () => ({
    inFlight: false,
    retryCount: 0,
    retryTimer: undefined,
    listener: undefined,
  }),
);

/**
 * Gateway recovery registers a listener so a restore that succeeds after the
 * one-shot startup wake still drains pending sessions.
 */
export function setRestoredFollowupQueuesListener(listener: (() => void) | undefined): void {
  restoreCoordination.listener = listener;
}

/** Drop the restore listener only when it is still the caller’s callback. */
export function unsetRestoredFollowupQueuesListener(listener: () => void): void {
  if (restoreCoordination.listener === listener) {
    restoreCoordination.listener = undefined;
  }
}

function notifyRestoredFollowupQueuesIfPending(): void {
  if (restoredPendingDrainKeys.size === 0) {
    return;
  }
  restoreCoordination.listener?.();
}

function followupQueuesGlobal(): FollowupQueuesGlobal {
  // SAFETY: this process-wide Symbol.for key stores only the optional restore-once boolean.
  return globalThis as FollowupQueuesGlobal;
}

function hasFollowupQueuesRestored(): boolean {
  return followupQueuesGlobal()[FOLLOWUP_QUEUES_RESTORED_KEY] === true;
}

function markFollowupQueuesRestored(): void {
  followupQueuesGlobal()[FOLLOWUP_QUEUES_RESTORED_KEY] = true;
}

function unmarkFollowupQueuesRestored(): void {
  delete followupQueuesGlobal()[FOLLOWUP_QUEUES_RESTORED_KEY];
}

function clearFollowupQueueRestoreRetryTimer(): void {
  if (restoreCoordination.retryTimer !== undefined) {
    clearTimeout(restoreCoordination.retryTimer);
    restoreCoordination.retryTimer = undefined;
  }
}

function scheduleFollowupQueueRestoreRetry(): void {
  if (restoreCoordination.retryCount >= MAX_FOLLOWUP_QUEUE_RESTORE_RETRIES) {
    return;
  }
  restoreCoordination.retryCount += 1;
  clearFollowupQueueRestoreRetryTimer();
  const delayMs = 100 * restoreCoordination.retryCount;
  restoreCoordination.retryTimer = setTimeout(() => {
    restoreCoordination.retryTimer = undefined;
    // A retry is best-effort: restore logs its own failures and a later caller
    // retries again, so nothing here can observe this promise.
    void restoreFollowupQueues().catch(() => undefined);
  }, delayMs);
}

/** For testing only — reset the restore-once flag between test cases. */
export function clearFollowupQueuesRestoredFlagForTest(): void {
  unmarkFollowupQueuesRestored();
  unreadableRestoredQueueKeys.clear();
  clearFollowupQueueLocalOwnershipForTest();
  restoreCoordination.inFlight = false;
  restoreCoordination.retryCount = 0;
  clearFollowupQueueRestoreRetryTimer();
}

/** For tests: whether any followup queue rows exist in shared SQLite state. */
export async function hasPersistedFollowupQueues(stateDir?: string): Promise<boolean> {
  return hasFollowupQueueEntries(stateDir);
}

// Resolve the current process config for restored runs. Prefer the live runtime
// snapshot (set by the agent runtime layer) so callers never pay disk IO. If
// the snapshot is not yet populated — e.g. restore runs before
// setRuntimeConfigSnapshot has been called during cold start — fall back to
// getRuntimeConfig() so restored followups dispatch with the current
// provider/channel/auth state rather than an empty stub. restoreFollowupQueues
// runs once at module init from a single point on the gateway boundary, so the
// getRuntimeConfig() fallback is a bounded process-boundary call (not an
// ambient hot-path lookup). If both paths fail, log and return an empty config;
// the dispatcher's resolveQueuedReplyExecutionConfig still has another chance
// to fill it from the runtime snapshot before the run is consumed.
function emptyRestoreConfig(): OpenClawConfig {
  // SAFETY: empty config fail-open; dispatch re-reads the live snapshot.
  return {} as OpenClawConfig;
}

function resolveCurrentRunConfig(): OpenClawConfig {
  const snapshot = getRuntimeConfigSnapshot();
  if (snapshot) {
    return snapshot;
  }
  try {
    return getRuntimeConfig();
  } catch (err) {
    defaultRuntime.error?.(
      `failed to load current config for followup queue restore: ${String(err)}`,
    );
    return emptyRestoreConfig();
  }
}

/**
 * True when this persisted entry would restore without skipping any
 * delivery-bearing source (items, overflow summarySources, or elision sources)
 * and without leaving overflow that the normal drain cannot deliver.
 *
 * Drain only sends overflow summaries when `droppedCount > 0`. A stored queue
 * that keeps summary sources/lines/elisions at `droppedCount === 0` would
 * never emit those summaries after restore.
 */
export function canMigrateFollowupQueueEntryLosslessly(
  queueKey: string,
  value: unknown,
): value is PersistedQueueEntry {
  if (!isPersistedQueueEntry(value)) {
    return false;
  }
  for (const elision of value.summaryElisions ?? []) {
    if (
      elision.count !== elision.sources.length ||
      elision.sources.length !== elision.summaryLines.length
    ) {
      return false;
    }
  }
  const summarySources = value.summarySources ?? [];
  const summaryLines = value.summaryLines ?? [];
  const elisions = value.summaryElisions ?? [];
  const elisionSourceCount = elisions.reduce((sum, elision) => sum + elision.sources.length, 0);
  const hasOverflowPayload =
    summarySources.length > 0 || elisions.length > 0 || summaryLines.length > 0;
  if (hasOverflowPayload && value.droppedCount <= 0) {
    return false;
  }
  if (summarySources.length !== summaryLines.length) {
    return false;
  }
  if (value.droppedCount < summarySources.length + elisionSourceCount) {
    return false;
  }
  const elisionSources = elisions.flatMap((elision) => elision.sources);
  const revalidation = createRestoreRevalidation(resolveCurrentRunConfig());
  return [...value.items, ...summarySources, ...elisionSources].every((item) =>
    isDeliverablePersistedFollowup(queueKey, item, revalidation),
  );
}

/**
 * Write all non-empty followup queues to disk so they survive gateway restarts.
 * Called after any mutation that changes queue contents (enqueue, drain, clear).
 *
 * Rows stay in SQLite until delivery settles (successful channel handoff or
 * fail-closed discard). In-flight marks are process-local only.
 */
export async function persistFollowupQueuesOrThrow(): Promise<void> {
  const entries: Array<[string, PersistedQueueEntry]> = [];
  for (const [key, queue] of FOLLOWUP_QUEUES) {
    if (
      !queue ||
      (queue.items.length === 0 && queue.inFlight.size === 0 && queue.droppedCount === 0)
    ) {
      continue;
    }
    if (isIncognitoFollowupQueue(key, queue)) {
      continue;
    }
    if (isFollowupQueueKeyRestartRetired(key)) {
      // The row is the next process's to replay. Work enqueued here after the
      // handoff stays in memory rather than replacing it.
      continue;
    }
    const entry = toPersistedQueueEntry(queue);
    if (!persistedQueueEntryCarriesWork(entry)) {
      // Nothing in this queue is eligible for durable custody here.
      // Writing an empty row would claim durable authority this queue does not have.
      continue;
    }
    entries.push([key, entry]);
  }
  await replaceFollowupQueueEntries({
    entries,
    retainKeys: await resolveFollowupQueueRetainKeys(),
  });
}

/**
 * Best-effort persist for non-critical callers (enqueue). Drain settlement uses
 * {@link persistFollowupQueuesOrThrow} so ack failures fail closed.
 */
export async function persistFollowupQueues(): Promise<void> {
  try {
    await persistFollowupQueuesOrThrow();
  } catch (err) {
    defaultRuntime.error?.(`failed to persist followup queues: ${String(err)}`);
  }
}

function installRestoredFollowupQueue(key: string, restored: FollowupQueueState): void {
  FOLLOWUP_QUEUES.set(key, restored);
  if (
    restored.items.length > 0 ||
    restored.droppedCount > 0 ||
    restored.summarySources.length > 0
  ) {
    restoredPendingDrainKeys.add(key);
  }
}

export type DurableFollowupQueueReconciliation =
  | { kind: "restored"; queue: FollowupQueueState }
  | { kind: "reconciled" }
  | { kind: "unreadable" };

/**
 * Reconcile one key's durable row before a live queue claims it.
 *
 * Until startup restore completes, the row may still hold the previous
 * process's work, and the next snapshot upsert would replace it with only the
 * live entries. Restore that row first. When it cannot be read, report it so the
 * caller refuses to admit work for this key rather than accept work it cannot
 * make durable.
 */
export async function reconcileDurableFollowupQueueKey(
  key: string,
): Promise<DurableFollowupQueueReconciliation> {
  if (isFollowupQueueKeyRestartRetired(key)) {
    // Restart retirement already completed these runs' lifecycles here and left
    // the row for startup recovery. Restoring it into a queue this process
    // materializes again would re-run settled work in the process that retired it.
    return { kind: "reconciled" };
  }
  if (
    isFollowupQueueKeyLocallyOwned(key) ||
    (hasFollowupQueuesRestored() && !unreadableRestoredQueueKeys.has(key))
  ) {
    return { kind: "reconciled" };
  }
  let rawData: unknown;
  try {
    rawData = loadFollowupQueueEntry(key);
  } catch (err) {
    defaultRuntime.error?.(`failed to reconcile durable followup queue ${key}: ${String(err)}`);
    return { kind: "unreadable" };
  }
  unreadableRestoredQueueKeys.delete(key);
  markFollowupQueueKeyLocallyOwned(key);
  if (rawData === undefined) {
    return { kind: "reconciled" };
  }
  const currentConfig = resolveCurrentRunConfig();
  const entry = restorePersistedFollowupQueueEntry(
    key,
    rawData,
    currentConfig,
    createRestoreRevalidation(currentConfig),
  );
  if (entry.queue) {
    installRestoredFollowupQueue(key, entry.queue);
  }
  if (entry.needsRewrite) {
    await persistFollowupQueues();
  }
  notifyRestoredFollowupQueuesIfPending();
  return entry.queue ? { kind: "restored", queue: entry.queue } : { kind: "reconciled" };
}

/**
 * Read persisted queue state from disk and populate FOLLOWUP_QUEUES.
 * Called once at module init, before any queue operations.
 */
export async function restoreFollowupQueues(): Promise<void> {
  // Restore exactly once per process after SQLite initialization succeeds.
  // A concurrent call from a second module evaluation must not replay restore
  // over an in-flight FOLLOWUP_QUEUES entry. If the first SQLite/schema access
  // fails transiently, leave the flag unset and retry so queued work is not
  // stranded until a manual restart.
  if (hasFollowupQueuesRestored() || restoreCoordination.inFlight) {
    return;
  }
  restoreCoordination.inFlight = true;
  let entries: Array<[string, unknown]>;
  let unreadableKeys: string[];
  try {
    entries = await loadFollowupQueueEntries();
    unreadableKeys = await listUnreadableFollowupQueueKeys();
  } catch (err) {
    restoreCoordination.inFlight = false;
    defaultRuntime.error?.(`failed to restore followup queues: ${String(err)}`);
    scheduleFollowupQueueRestoreRetry();
    return;
  }
  unreadableRestoredQueueKeys.clear();
  for (const key of unreadableKeys) {
    unreadableRestoredQueueKeys.add(key);
  }
  markFollowupQueuesRestored();
  restoreCoordination.inFlight = false;
  restoreCoordination.retryCount = 0;
  try {
    let needsRewrite = false;
    if (entries.length > 0) {
      const currentConfig = resolveCurrentRunConfig();
      const revalidation = createRestoreRevalidation(currentConfig);
      for (const entry of entries) {
        const key = normalizeOptionalString(Array.isArray(entry) ? entry[0] : undefined);
        if (!key) {
          continue;
        }
        if (FOLLOWUP_QUEUES.has(key) && isFollowupQueueKeyLocallyOwned(key)) {
          // A live queue already reconciled this row before restore could run.
          continue;
        }
        if (isFollowupQueueKeyRestartRetired(key)) {
          // A restore retry that lands after restart retirement must not revive
          // the row this process already handed to startup recovery.
          continue;
        }
        // Reading the row transfers delete authority to this process, including
        // for rows that fail closed below — the sanitizing persist must be able to
        // remove them rather than retain them as unreconciled durable work.
        markFollowupQueueKeyLocallyOwned(key);
        const restored = restorePersistedFollowupQueueEntry(
          key,
          Array.isArray(entry) ? entry[1] : undefined,
          currentConfig,
          revalidation,
        );
        needsRewrite ||= restored.needsRewrite;
        if (restored.queue) {
          installRestoredFollowupQueue(key, restored.queue);
        }
      }
    }
    if (needsRewrite) {
      // Durable non-delivery: drop fail-closed rows, and rewrite descriptors
      // that still carried raw source-session provenance, sender/channel
      // identities, or current-turn inbound prompt context so restart cannot
      // revive those requester-policy inputs.
      await persistFollowupQueuesOrThrow();
    }
  } catch (err) {
    defaultRuntime.error?.(`failed to restore followup queues: ${String(err)}`);
  }
  notifyRestoredFollowupQueuesIfPending();
}
