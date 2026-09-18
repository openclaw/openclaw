// Tracks queue state for active, pending, and recently deduped reply runs.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelCatalogEntry } from "../../../agents/model-catalog.types.js";
import type { ModelFallbackRouteResolution } from "../../../agents/model-fallback.types.js";
import { resolveThinkingSelection } from "../../../agents/model-thinking-default.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { applyQueueRuntimeSettings } from "../../../utils/queue-helpers.js";
import { normalizeThinkLevel } from "../../thinking.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import {
  markFollowupQueueKeyLocallyOwned,
  markFollowupQueueKeyRestartRetired,
  releaseFollowupQueueKeyLocalOwnership,
} from "./persist-snapshot-policy.js";
import {
  clearRestoredPendingDrainKey,
  persistFollowupQueuesOrThrow,
  reconcileDurableFollowupQueueKey,
} from "./persist.js";
import type { FollowupQueueState, FollowupRun, QueueDropPolicy, QueueSettings } from "./types.js";

export const DEFAULT_QUEUE_DEBOUNCE_MS = 500;
export const DEFAULT_QUEUE_CAP = 20;
export const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

/**
 * Share followup queues across bundled chunks so busy-session enqueue/drain
 * logic observes one queue registry per process.
 */
const FOLLOWUP_QUEUES_KEY = Symbol.for("openclaw.followupQueues");

export const FOLLOWUP_QUEUES = resolveGlobalMap<string, FollowupQueueState>(FOLLOWUP_QUEUES_KEY);

export function* followupQueueSources(
  queue: Pick<FollowupQueueState, "items" | "summarySources" | "summaryElisions">,
): Generator<FollowupRun> {
  yield* queue.items;
  yield* queue.summarySources;
  for (const entry of queue.summaryElisions) {
    yield* entry.sources;
  }
}

export function getExistingFollowupQueue(key: string): FollowupQueueState | undefined {
  const cleaned = key.trim();
  if (!cleaned) {
    return undefined;
  }
  const queue = FOLLOWUP_QUEUES.get(cleaned);
  if (!queue) {
    return undefined;
  }
  ensureFollowupQueueSummaryState(queue);
  return queue;
}

function ensureFollowupQueueSummaryState(queue: FollowupQueueState): void {
  queue.summarySources ??= [];
  queue.summaryElisions ??= [];
  queue.evictedSummaryCount ??= 0;
  queue.steerAcceptanceTail ??= Promise.resolve(true);
}

export function hasPendingFollowupQueueWork(keys: Iterable<string | undefined>): boolean {
  const seen = new Set<string>();
  for (const key of keys) {
    const cleaned = normalizeOptionalString(key);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    const queue = getExistingFollowupQueue(cleaned);
    if (queue && (queue.items.length > 0 || queue.inFlight.size > 0 || queue.droppedCount > 0)) {
      return true;
    }
  }
  return false;
}

type SummaryElisionCapState = Pick<
  FollowupQueueState,
  "activeSummarySources" | "cap" | "evictedSummaryCount" | "summaryElisions"
>;

/**
 * Trim overflow summary-elision sources down to the queue cap.
 *
 * By default, completes the lifecycle of each evicted source. Pass
 * `deferLifecycleCompletion: true` when the caller needs atomic rollback across a
 * later durable write — evicted sources are returned instead of completed.
 */
export function trimSummaryElisionsToCap(
  queue: SummaryElisionCapState,
  options?: { deferLifecycleCompletion?: boolean },
): FollowupRun[] {
  const deferredCompletions: FollowupRun[] = [];
  let sourceCount = queue.summaryElisions.reduce(
    (count, entry) =>
      count + entry.sources.filter((source) => !queue.activeSummarySources.has(source)).length,
    0,
  );
  while (sourceCount > queue.cap) {
    let evicted = false;
    for (const [entryIndex, entry] of queue.summaryElisions.entries()) {
      const sourceIndex = entry.sources.findIndex(
        (source) => !queue.activeSummarySources.has(source),
      );
      if (sourceIndex < 0) {
        continue;
      }
      const [source] = entry.sources.splice(sourceIndex, 1);
      entry.summaryLines.splice(sourceIndex, 1);
      entry.count = entry.sources.length;
      queue.evictedSummaryCount += 1;
      sourceCount -= 1;
      if (source) {
        if (options?.deferLifecycleCompletion) {
          deferredCompletions.push(source);
        } else {
          completeFollowupRunLifecycle(source);
        }
      }
      if (entry.sources.length === 0) {
        queue.summaryElisions.splice(entryIndex, 1);
      }
      evicted = true;
      break;
    }
    if (!evicted) {
      // A deferred delivery temporarily retains at most one queue-cap-sized active set.
      return deferredCompletions;
    }
  }
  return deferredCompletions;
}

async function persistCapDrivenElisionTrim(queue: FollowupQueueState): Promise<void> {
  const snapshotElisions = queue.summaryElisions.map((elision) => ({
    contextKey: elision.contextKey,
    count: elision.count,
    sources: elision.sources.slice(),
    summaryLines: elision.summaryLines.slice(),
    sourceRefs: elision.sourceRefs,
  }));
  const snapshotEvictedSummaryCount = queue.evictedSummaryCount;
  const deferredCompletions = trimSummaryElisionsToCap(queue, { deferLifecycleCompletion: true });
  if (
    deferredCompletions.length === 0 &&
    queue.evictedSummaryCount === snapshotEvictedSummaryCount
  ) {
    return;
  }
  try {
    await persistFollowupQueuesOrThrow();
  } catch (err) {
    queue.summaryElisions.splice(0, queue.summaryElisions.length, ...snapshotElisions);
    queue.evictedSummaryCount = snapshotEvictedSummaryCount;
    throw err;
  }
  for (const source of deferredCompletions) {
    completeFollowupRunLifecycle(source);
  }
}

export async function getFollowupQueue(
  key: string,
  settings: QueueSettings,
  options?: {
    /**
     * Materialize without reading the durable row.
     *
     * Only for work this owner never writes (sender-bound, incognito,
     * operator-authority-bound). Such a queue has nothing to reconcile against,
     * so a shared-SQLite outage must not reject its first use. Durable delete
     * authority is deliberately not claimed: the row, if any, stays for whoever
     * can read it.
     */
    memoryOnly?: boolean;
  },
): Promise<FollowupQueueState> {
  const existing = FOLLOWUP_QUEUES.get(key);
  if (existing) {
    ensureFollowupQueueSummaryState(existing);
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    await persistCapDrivenElisionTrim(existing);
    return existing;
  }

  // Before restore completes, this key's row may still hold the previous
  // process's work. Restore it first so new work appends behind it instead of
  // replacing it on the next snapshot upsert.
  const reconciliation = options?.memoryOnly
    ? ({ kind: "reconciled" } as const)
    : await reconcileDurableFollowupQueueKey(key);
  if (reconciliation.kind === "restored") {
    const restored = reconciliation.queue;
    ensureFollowupQueueSummaryState(restored);
    applyQueueRuntimeSettings({
      target: restored,
      settings,
    });
    await persistCapDrivenElisionTrim(restored);
    return restored;
  }
  if (reconciliation.kind === "unreadable") {
    // The row exists but its contents are unknown. A queue created now could
    // only admit work by replacing that row, so refuse to materialize it; the
    // caller rejects the turn and the next attempt reads the row again.
    throw new Error(`followup queue ${key} has a durable row that could not be read`);
  }

  const created: FollowupQueueState = {
    abortController: new AbortController(),
    items: [],
    draining: false,
    inFlight: new Set(),
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs: DEFAULT_QUEUE_DEBOUNCE_MS,
    cap: DEFAULT_QUEUE_CAP,
    dropPolicy: DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines: [],
    summarySources: [],
    steerAcceptanceTail: Promise.resolve(true),
    activeSummarySources: new WeakSet(),
    summaryElisions: [],
    evictedSummaryCount: 0,
  };
  applyQueueRuntimeSettings({
    target: created,
    settings,
  });
  // Materializing the queue takes durable delete authority for this key, so a
  // later snapshot may remove its row once the queue empties. A memory-only
  // queue never read the row, so it must not claim authority to delete it.
  if (!options?.memoryOnly) {
    markFollowupQueueKeyLocallyOwned(key);
  }
  FOLLOWUP_QUEUES.set(key, created);
  return created;
}

/**
 * Drop process-local queue authority for an orderly restart, leaving the durable
 * snapshot intact.
 *
 * `clearFollowupQueue` is intentional cancellation and persists the queue's
 * removal. Restart retirement is not cancellation — startup recovery is supposed
 * to replay this work — so the row stays and delete authority is handed back so
 * that a later snapshot driven by another key cannot remove it.
 */
export function retireFollowupQueueForRestart(key: string): number {
  const cleaned = key.trim();
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    return 0;
  }
  const retiredItems = queue.items.slice();
  const retiredSources = [
    ...queue.summarySources,
    ...queue.summaryElisions.flatMap((elision) => elision.sources),
  ];
  const retired = retiredItems.length + queue.droppedCount;

  queue.items.length = 0;
  queue.inFlight.clear();
  queue.droppedCount = 0;
  queue.summaryLines = [];
  queue.summarySources = [];
  queue.summaryElisions = [];
  queue.evictedSummaryCount = 0;
  queue.lastRun = undefined;
  queue.lastEnqueuedAt = 0;
  FOLLOWUP_QUEUES.delete(cleaned);
  // Release before completing lifecycles so a hook that triggers a snapshot
  // still retains this row, and record the handoff so nothing in this process
  // reads the row back or overwrites it with post-retirement work.
  releaseFollowupQueueKeyLocalOwnership(cleaned);
  markFollowupQueueKeyRestartRetired(cleaned);
  queue.abortController.abort();
  for (const item of [...retiredItems, ...retiredSources]) {
    completeFollowupRunLifecycle(item);
  }
  return retired;
}

export async function clearFollowupQueue(key: string): Promise<number> {
  const cleaned = key.trim();
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    clearRestoredPendingDrainKey(cleaned);
    return 0;
  }
  const clearedItems = queue.items.slice();
  const clearedSummarySources = queue.summarySources.slice();
  const clearedSummaryElisions = queue.summaryElisions.map((elision) => ({
    contextKey: elision.contextKey,
    count: elision.count,
    sources: elision.sources.slice(),
    summaryLines: elision.summaryLines.slice(),
    sourceRefs: elision.sourceRefs,
  }));
  const clearedSummaryLines = queue.summaryLines.slice();
  const clearedInFlight = [...queue.inFlight];
  const clearedDroppedCount = queue.droppedCount;
  const clearedLastRun = queue.lastRun;
  const clearedLastEnqueuedAt = queue.lastEnqueuedAt;
  const clearedEvictedSummaryCount = queue.evictedSummaryCount;
  const cleared = clearedItems.length + clearedDroppedCount;

  // Wipe durable + memory state first. Abort only after SQLite acknowledges the
  // clear so a failed write can restore prior work with live queue abort signals.
  queue.items.length = 0;
  queue.inFlight.clear();
  queue.droppedCount = 0;
  queue.summaryLines = [];
  queue.summarySources = [];
  queue.summaryElisions = [];
  queue.evictedSummaryCount = 0;
  queue.lastRun = undefined;
  queue.lastEnqueuedAt = 0;
  FOLLOWUP_QUEUES.delete(cleaned);
  try {
    await persistFollowupQueuesOrThrow();
  } catch (err) {
    queue.items.splice(0, 0, ...clearedItems);
    queue.summarySources.splice(0, 0, ...clearedSummarySources);
    queue.summaryElisions.splice(0, 0, ...clearedSummaryElisions);
    queue.summaryLines.splice(0, 0, ...clearedSummaryLines);
    for (const item of clearedInFlight) {
      queue.inFlight.add(item);
    }
    queue.droppedCount = clearedDroppedCount;
    queue.lastRun = clearedLastRun;
    queue.lastEnqueuedAt = clearedLastEnqueuedAt;
    queue.evictedSummaryCount = clearedEvictedSummaryCount;
    FOLLOWUP_QUEUES.set(cleaned, queue);
    throw err;
  }
  clearRestoredPendingDrainKey(cleaned);
  queue.abortController.abort();
  for (const item of clearedItems) {
    completeFollowupRunLifecycle(item);
  }
  for (const item of clearedSummarySources) {
    completeFollowupRunLifecycle(item);
  }
  for (const entry of clearedSummaryElisions) {
    for (const source of entry.sources) {
      completeFollowupRunLifecycle(source);
    }
  }
  return cleared;
}

export function clearRemovedQueuedAuthProfiles(params: {
  removedByAgent: ReadonlyMap<string, ReadonlySet<string>>;
  rewriteConfig: (cfg: OpenClawConfig) => OpenClawConfig;
}): void {
  const clearRun = (run: FollowupRun["run"]) => {
    const removed = params.removedByAgent.get(normalizeAgentId(run.agentId));
    if (!removed?.size) {
      return;
    }
    // Pending work retains config as well as a selected account. Clear both sources
    // so a later model switch cannot restore the deleted account from its snapshot.
    run.config = params.rewriteConfig(run.config);
    if (run.authProfileId && removed.has(run.authProfileId)) {
      delete run.authProfileId;
      delete run.authProfileIdSource;
    }
    const probe = run.autoFallbackPrimaryProbe;
    if (probe?.fallbackAuthProfileId && removed.has(probe.fallbackAuthProfileId)) {
      delete probe.fallbackAuthProfileId;
      delete probe.fallbackAuthProfileIdSource;
    }
  };
  for (const queue of FOLLOWUP_QUEUES.values()) {
    if (queue.lastRun) {
      clearRun(queue.lastRun);
    }
    for (const item of followupQueueSources(queue)) {
      clearRun(item.run);
    }
  }
}

export async function refreshQueuedFollowupSession(params: {
  key: string;
  previousSessionId?: string;
  nextSessionId?: string;
  nextSessionFile?: string;
  nextProvider?: string;
  nextModel?: string;
  nextRouteResolution?: ModelFallbackRouteResolution;
  nextModelOverrideSource?: "auto" | "user";
  nextAuthProfileId?: string;
  nextAuthProfileIdSource?: "auto" | "user";
  nextThinking?: {
    level?: string;
    catalog?: ModelCatalogEntry[];
    agentRuntime?: string | null;
  };
}): Promise<void> {
  const queue = getExistingFollowupQueue(params.key);
  if (!queue) {
    return;
  }
  const shouldRewriteSession =
    Boolean(params.previousSessionId) &&
    Boolean(params.nextSessionId) &&
    params.previousSessionId !== params.nextSessionId;
  const hasNextModelRoute =
    typeof params.nextProvider === "string" || typeof params.nextModel === "string";
  const shouldRewriteModelSelection =
    hasNextModelRoute || Object.hasOwn(params, "nextModelOverrideSource");
  const shouldRewriteSelection =
    shouldRewriteModelSelection ||
    Object.hasOwn(params, "nextAuthProfileId") ||
    Object.hasOwn(params, "nextAuthProfileIdSource") ||
    params.nextThinking !== undefined;
  if (!shouldRewriteSession && !shouldRewriteSelection) {
    return;
  }

  const rewriteRun = (run: FollowupRun["run"]) => {
    if (shouldRewriteSession && run.sessionId === params.previousSessionId) {
      run.sessionId = params.nextSessionId!;
      const nextSessionFile = normalizeOptionalString(params.nextSessionFile);
      if (nextSessionFile) {
        run.sessionFile = nextSessionFile;
      }
    }
    if (shouldRewriteSelection) {
      if (typeof params.nextProvider === "string") {
        run.provider = params.nextProvider;
      }
      if (typeof params.nextModel === "string") {
        run.model = params.nextModel;
      }
      if (hasNextModelRoute) {
        run.requestedRouteResolution = params.nextRouteResolution ?? "raw";
      }
      if (shouldRewriteModelSelection) {
        delete run.hasAutoFallbackProvenance;
      }
      if (Object.hasOwn(params, "nextModelOverrideSource")) {
        run.hasSessionModelOverride =
          params.nextModelOverrideSource !== undefined && Boolean(run.provider || run.model);
        run.modelOverrideSource = params.nextModelOverrideSource;
      }
      if (Object.hasOwn(params, "nextAuthProfileId")) {
        run.authProfileId = normalizeOptionalString(params.nextAuthProfileId);
      }
      if (Object.hasOwn(params, "nextAuthProfileIdSource")) {
        run.authProfileIdSource = run.authProfileId ? params.nextAuthProfileIdSource : undefined;
      }
      if (params.nextThinking) {
        run.thinkingCatalog = params.nextThinking.catalog;
        const explicitLevel =
          run.thinkLevelOverride === "default"
            ? undefined
            : (run.thinkLevelOverride ?? normalizeThinkLevel(params.nextThinking.level));
        run.thinkLevel = resolveThinkingSelection({
          cfg: run.config,
          agentId: run.agentId,
          provider: run.provider,
          model: run.model,
          catalog: params.nextThinking.catalog,
          agentRuntime: params.nextThinking.agentRuntime,
          level: explicitLevel,
        }).level;
      }
    }
  };

  // Snapshot the fields the rewrite touches so a failed durable write leaves the
  // in-memory runs exactly as they were; the rewrite itself is not rolled back
  // by SQLite.
  const snapshotRunFields = (run: FollowupRun["run"]) => ({
    sessionId: run.sessionId,
    sessionFile: run.sessionFile,
    provider: run.provider,
    model: run.model,
    requestedRouteResolution: run.requestedRouteResolution,
    hasAutoFallbackProvenance: run.hasAutoFallbackProvenance,
    hasSessionModelOverride: run.hasSessionModelOverride,
    modelOverrideSource: run.modelOverrideSource,
    authProfileId: run.authProfileId,
    authProfileIdSource: run.authProfileIdSource,
    thinkingCatalog: run.thinkingCatalog,
    thinkLevel: run.thinkLevel,
  });
  const priorSnapshots = [
    ...(queue.lastRun ? [queue.lastRun] : []),
    ...[...followupQueueSources(queue)].map((item) => item.run),
  ].map((run) => ({ run, fields: snapshotRunFields(run) }));

  if (queue.lastRun) {
    rewriteRun(queue.lastRun);
  }
  for (const item of followupQueueSources(queue)) {
    rewriteRun(item.run);
  }
  try {
    await persistFollowupQueuesOrThrow();
  } catch (err) {
    for (const { run, fields } of priorSnapshots) {
      run.sessionId = fields.sessionId;
      run.sessionFile = fields.sessionFile;
      run.provider = fields.provider;
      run.model = fields.model;
      run.requestedRouteResolution = fields.requestedRouteResolution;
      if (fields.hasAutoFallbackProvenance === undefined) {
        delete run.hasAutoFallbackProvenance;
      } else {
        run.hasAutoFallbackProvenance = fields.hasAutoFallbackProvenance;
      }
      if (fields.hasSessionModelOverride === undefined) {
        delete run.hasSessionModelOverride;
      } else {
        run.hasSessionModelOverride = fields.hasSessionModelOverride;
      }
      run.modelOverrideSource = fields.modelOverrideSource;
      run.authProfileId = fields.authProfileId;
      run.authProfileIdSource = fields.authProfileIdSource;
      run.thinkingCatalog = fields.thinkingCatalog;
      run.thinkLevel = fields.thinkLevel;
    }
    throw err;
  }
}
