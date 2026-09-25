// Tracks queue state for active, pending, and recently deduped reply runs.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ModelCatalogEntry } from "../../../agents/model-catalog.types.js";
import type { ModelFallbackRouteResolution } from "../../../agents/model-fallback.types.js";
import { resolveThinkingSelection } from "../../../agents/model-thinking-default.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { applyQueueRuntimeSettings } from "../../../utils/queue-helpers.js";
import { normalizeThinkLevel } from "../../thinking.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import type { FollowupRun, QueueDropPolicy, QueueSettings } from "./types.js";

type FollowupQueueState = {
  abortController: AbortController;
  items: FollowupRun[];
  draining: boolean;
  /** Exact operational drain generation; recovery may retire only this owner. */
  drainOwner?: object;
  /** Identities retained in `items` while delivery awaits; pending cap and depth must exclude them. */
  inFlight: Set<FollowupRun>;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  summarySources: FollowupRun[];
  steerAcceptanceTail: Promise<boolean>;
  /** Sources currently used by an async summary delivery cannot be evicted mid-run. */
  activeSummarySources: WeakSet<FollowupRun>;
  summaryElisions: Array<{
    contextKey: string;
    count: number;
    /** Compact sources stay strong so cancellation follows summarized content until delivery. */
    sources: FollowupRun[];
    /** Summary lines stay index-aligned with sources across context isolation and eviction. */
    summaryLines: string[];
    /** Weak source mapping keeps concurrent summary consumption identity-safe. */
    sourceRefs: WeakMap<FollowupRun, FollowupRun>;
  }>;
  evictedSummaryCount: number;
  // Collected transcript recorders retain this source after admission removes queue items.
  lastRun?: FollowupRun["run"];
};

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
  return FOLLOWUP_QUEUES.get(cleaned);
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

export function trimSummaryElisionsToCap(queue: SummaryElisionCapState): void {
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
        completeFollowupRunLifecycle(source);
      }
      if (entry.sources.length === 0) {
        queue.summaryElisions.splice(entryIndex, 1);
      }
      evicted = true;
      break;
    }
    if (!evicted) {
      // A deferred delivery temporarily retains at most one queue-cap-sized active set.
      return;
    }
  }
}

export function getFollowupQueue(key: string, settings: QueueSettings): FollowupQueueState {
  const existing = FOLLOWUP_QUEUES.get(key);
  if (existing) {
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    trimSummaryElisionsToCap(existing);
    return existing;
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
  FOLLOWUP_QUEUES.set(key, created);
  return created;
}

export function clearFollowupQueue(key: string): number {
  const cleaned = key.trim();
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    return 0;
  }
  queue.abortController.abort();
  const cleared = queue.items.length + queue.droppedCount;
  for (const item of followupQueueSources(queue)) {
    completeFollowupRunLifecycle(item);
  }
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

export function refreshQueuedFollowupSession(params: {
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
}): void {
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

  if (queue.lastRun) {
    rewriteRun(queue.lastRun);
  }
  for (const item of followupQueueSources(queue)) {
    rewriteRun(item.run);
  }
}
