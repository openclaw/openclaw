// Tracks queue state for active, pending, and recently deduped reply runs.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { applyQueueRuntimeSettings } from "../../../utils/queue-helpers.js";
import {
  normalizeThinkLevel,
  resolveSupportedThinkingLevel,
  resolveThinkingDefaultForModel,
  type ThinkingCatalogEntry,
} from "../../thinking.js";
import {
  createSteeringAuthorizationAffinity,
  resolveSteeringAuthorizationAffinityKey,
} from "../steering-authorization-affinity.js";
import {
  completeFollowupRunLifecycle,
  type FollowupRun,
  type QueueDropPolicy,
  type QueueMode,
  type QueueSettings,
} from "./types.js";

type FollowupQueueState = {
  abortController: AbortController;
  items: FollowupRun[];
  draining: boolean;
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
  /** Sources currently used by an async summary delivery cannot be evicted mid-run. */
  activeSummarySources: WeakSet<FollowupRun>;
  summaryElisions: Array<{
    contextKey: string;
    count: number;
    /** Compact sources stay strong so cancellation follows summarized content until delivery. */
    sources: FollowupRun[];
    /** Weak source mapping keeps concurrent summary consumption identity-safe. */
    sourceRefs: WeakMap<FollowupRun, FollowupRun>;
  }>;
  evictedSummaryCount: number;
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

export function getExistingFollowupQueue(key: string): FollowupQueueState | undefined {
  const cleaned = key.trim();
  if (!cleaned) {
    return undefined;
  }
  return FOLLOWUP_QUEUES.get(cleaned);
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
    debounceMs:
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : DEFAULT_QUEUE_DEBOUNCE_MS,
    cap:
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : DEFAULT_QUEUE_CAP,
    dropPolicy: settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines: [],
    summarySources: [],
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
  for (const item of queue.items) {
    completeFollowupRunLifecycle(item);
  }
  for (const item of queue.summarySources) {
    completeFollowupRunLifecycle(item);
  }
  for (const entry of queue.summaryElisions) {
    for (const source of entry.sources) {
      completeFollowupRunLifecycle(source);
    }
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

function followupRunMatchesAuthorizationAffinity(
  run: FollowupRun,
  authorizationAffinityKey: string,
): boolean {
  return (
    resolveSteeringAuthorizationAffinityKey(
      createSteeringAuthorizationAffinity({ turnAuthority: run.run.turnAuthority }),
    ) === authorizationAffinityKey
  );
}

/**
 * Clear only pending work issued to one exact turn authority. In-flight work
 * stays owned by its drain; the active-run controller is responsible for aborting it.
 */
export function clearFollowupQueueByAuthorizationAffinity(
  key: string,
  authorizationAffinityKey: string | undefined,
): number {
  const cleaned = key.trim();
  const affinityKey = authorizationAffinityKey?.trim();
  if (!cleaned || !affinityKey) {
    return 0;
  }
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    return 0;
  }

  let cleared = 0;
  const removeSource = (source: FollowupRun) => {
    completeFollowupRunLifecycle(source);
    cleared += 1;
  };
  for (let index = queue.items.length - 1; index >= 0; index -= 1) {
    const item = queue.items[index];
    if (
      !item ||
      queue.inFlight.has(item) ||
      !followupRunMatchesAuthorizationAffinity(item, affinityKey)
    ) {
      continue;
    }
    queue.items.splice(index, 1);
    removeSource(item);
  }
  for (let index = queue.summarySources.length - 1; index >= 0; index -= 1) {
    const source = queue.summarySources[index];
    if (
      !source ||
      queue.activeSummarySources.has(source) ||
      !followupRunMatchesAuthorizationAffinity(source, affinityKey)
    ) {
      continue;
    }
    queue.summarySources.splice(index, 1);
    queue.summaryLines.splice(index, 1);
    queue.droppedCount = Math.max(0, queue.droppedCount - 1);
    removeSource(source);
  }
  for (let entryIndex = queue.summaryElisions.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = queue.summaryElisions[entryIndex];
    if (!entry) {
      continue;
    }
    const matchingSources = entry.sources.filter((source) =>
      followupRunMatchesAuthorizationAffinity(source, affinityKey),
    );
    if (matchingSources.length === 0) {
      continue;
    }
    // Delivery-context elisions are authority-homogeneous. `count` tracks logical
    // dropped work; retained sources are lifecycle handles and may be capped separately.
    if (
      matchingSources.length === entry.sources.length &&
      matchingSources.every((source) => !queue.activeSummarySources.has(source))
    ) {
      queue.summaryElisions.splice(entryIndex, 1);
      queue.droppedCount = Math.max(0, queue.droppedCount - entry.count);
      for (const source of entry.sources) {
        completeFollowupRunLifecycle(source);
      }
      cleared += entry.count;
      continue;
    }
    let removedCount = 0;
    for (let sourceIndex = entry.sources.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
      const source = entry.sources[sourceIndex];
      if (
        !source ||
        queue.activeSummarySources.has(source) ||
        !followupRunMatchesAuthorizationAffinity(source, affinityKey)
      ) {
        continue;
      }
      entry.sources.splice(sourceIndex, 1);
      completeFollowupRunLifecycle(source);
      removedCount += 1;
    }
    entry.count = Math.max(0, entry.count - removedCount);
    queue.droppedCount = Math.max(0, queue.droppedCount - removedCount);
    cleared += removedCount;
    if (entry.count === 0) {
      queue.summaryElisions.splice(entryIndex, 1);
    }
  }

  if (cleared === 0) {
    return 0;
  }
  const remainingSources = [
    ...queue.items,
    ...queue.summarySources,
    ...queue.summaryElisions.flatMap((entry) => entry.sources),
  ];
  const newestRemainingSource = remainingSources.reduce<FollowupRun | undefined>(
    (newest, source) => (!newest || source.enqueuedAt > newest.enqueuedAt ? source : newest),
    undefined,
  );
  queue.lastRun = newestRemainingSource?.run;
  queue.lastEnqueuedAt = newestRemainingSource?.enqueuedAt ?? 0;

  if (
    !queue.draining &&
    queue.items.length === 0 &&
    queue.droppedCount === 0 &&
    queue.inFlight.size === 0
  ) {
    queue.abortController.abort();
    FOLLOWUP_QUEUES.delete(cleaned);
  }
  return cleared;
}

export function refreshQueuedFollowupSession(params: {
  key: string;
  previousSessionId?: string;
  nextSessionId?: string;
  nextSessionFile?: string;
  nextProvider?: string;
  nextModel?: string;
  nextModelOverrideSource?: "auto" | "user";
  nextAuthProfileId?: string;
  nextAuthProfileIdSource?: "auto" | "user";
  nextThinking?: {
    level?: string;
    catalog?: ThinkingCatalogEntry[];
    agentRuntime?: string | null;
  };
}): void {
  const cleaned = params.key.trim();
  if (!cleaned) {
    return;
  }
  const queue = getExistingFollowupQueue(cleaned);
  if (!queue) {
    return;
  }
  const shouldRewriteSession =
    Boolean(params.previousSessionId) &&
    Boolean(params.nextSessionId) &&
    params.previousSessionId !== params.nextSessionId;
  const shouldRewriteModelSelection =
    typeof params.nextProvider === "string" ||
    typeof params.nextModel === "string" ||
    Object.hasOwn(params, "nextModelOverrideSource");
  const shouldRewriteSelection =
    shouldRewriteModelSelection ||
    Object.hasOwn(params, "nextAuthProfileId") ||
    Object.hasOwn(params, "nextAuthProfileIdSource") ||
    params.nextThinking !== undefined;
  if (!shouldRewriteSession && !shouldRewriteSelection) {
    return;
  }

  const rewriteRun = (run?: FollowupRun["run"]) => {
    if (!run) {
      return;
    }
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
      if (shouldRewriteModelSelection) {
        delete run.hasAutoFallbackProvenance;
      }
      if (Object.hasOwn(params, "nextModelOverrideSource")) {
        run.hasSessionModelOverride = Boolean(run.provider || run.model);
        run.modelOverrideSource = params.nextModelOverrideSource;
      }
      if (Object.hasOwn(params, "nextAuthProfileId")) {
        run.authProfileId = normalizeOptionalString(params.nextAuthProfileId);
      }
      if (Object.hasOwn(params, "nextAuthProfileIdSource")) {
        run.authProfileIdSource = run.authProfileId ? params.nextAuthProfileIdSource : undefined;
      }
      if (params.nextThinking) {
        const explicitLevel = normalizeThinkLevel(params.nextThinking.level);
        run.thinkLevel = explicitLevel
          ? resolveSupportedThinkingLevel({
              provider: run.provider,
              model: run.model,
              level: explicitLevel,
              catalog: params.nextThinking.catalog,
              agentRuntime: params.nextThinking.agentRuntime,
            })
          : resolveThinkingDefaultForModel({
              provider: run.provider,
              model: run.model,
              catalog: params.nextThinking.catalog,
              agentRuntime: params.nextThinking.agentRuntime,
            });
      }
    }
  };

  rewriteRun(queue.lastRun);
  for (const item of queue.items) {
    rewriteRun(item.run);
  }
  for (const item of queue.summarySources) {
    rewriteRun(item.run);
  }
  for (const entry of queue.summaryElisions) {
    for (const source of entry.sources) {
      rewriteRun(source.run);
    }
  }
}
