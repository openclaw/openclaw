import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../../config/io.js";
import { resolveStateDir } from "../../../config/paths.js";
import { getRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  hasFollowupQueueEntries,
  loadFollowupQueueEntries,
  replaceFollowupQueueEntries,
} from "../../../infra/followup-queue-sqlite.js";
import { defaultRuntime } from "../../../runtime.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { normalizeQueueDropPolicy, normalizeQueueMode } from "./normalize.js";
import type { FollowupQueueState, FollowupRun, QueueDropPolicy, QueueMode } from "./types.js";

export const LEGACY_FOLLOWUP_QUEUE_STATE_FILENAME = "live-chat-followup-queues.json";

const DEFAULT_QUEUE_DEBOUNCE_MS = 500;
const DEFAULT_QUEUE_CAP = 20;
const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

const FOLLOWUP_QUEUES = resolveGlobalMap<string, FollowupQueueState>(
  Symbol.for("openclaw.followupQueues"),
);

/**
 * Keys of non-empty queues restored from disk on this process start.
 * Entries are removed when kickFollowupDrainIfIdle runs for the route.
 * Production drains restored items after restart when agent-runner enqueues
 * with restartIfIdle=true, or when gateway startup wakes the session.
 */
const restoredPendingDrainKeys = new Set<string>();

export function peekRestoredPendingDrainKeys(): ReadonlySet<string> {
  return restoredPendingDrainKeys;
}

export function clearRestoredPendingDrainKey(key: string): void {
  restoredPendingDrainKeys.delete(key);
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
// fresh queued item. Symbol.for is used directly on globalThis (not via
// resolveGlobalSingleton) so the flag is shared by reference across split
// runtime chunks — see the note in src/shared/global-singleton.ts.
const FOLLOWUP_QUEUES_RESTORED_KEY = Symbol.for("openclaw.followupQueuesRestored");
type FollowupQueuesGlobal = { [FOLLOWUP_QUEUES_RESTORED_KEY]?: boolean };

function hasFollowupQueuesRestored(): boolean {
  return (globalThis as FollowupQueuesGlobal)[FOLLOWUP_QUEUES_RESTORED_KEY] === true;
}

function markFollowupQueuesRestored(): void {
  (globalThis as FollowupQueuesGlobal)[FOLLOWUP_QUEUES_RESTORED_KEY] = true;
}

/** For testing only — reset the restore-once flag between test cases. */
export function clearFollowupQueuesRestoredFlagForTest(): void {
  delete (globalThis as FollowupQueuesGlobal)[FOLLOWUP_QUEUES_RESTORED_KEY];
}

export function resolveFollowupQueueStatePath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, LEGACY_FOLLOWUP_QUEUE_STATE_FILENAME);
}

/** For tests: whether any followup queue rows exist in shared SQLite state. */
export function hasPersistedFollowupQueues(stateDir?: string): boolean {
  return hasFollowupQueueEntries(stateDir);
}

/**
 * Minimal recovery descriptor for FollowupRun["run"]. Persisted fields are the
 * per-message identity, routing, and intent inputs that cannot be recovered any
 * other way after a restart. Bulky or secret-bearing runtime state (config,
 * skillsSnapshot, extraSystemPrompt[Static]) is intentionally excluded — the
 * dispatcher reassigns `run.config` via resolveQueuedReplyExecutionConfig on the
 * next turn. Routing selectors (authProfileId[Source], inputProvenance,
 * originatingReplyToId) are persisted because restored turns need the same
 * reply target and message-context provenance they were queued with.
 *
 * Use Pick (allowlist), not Omit, so new fields added to FollowupRun["run"]
 * default to NOT persisted until explicitly opted in.
 */
type PersistedRunFields = Pick<
  FollowupRun["run"],
  | "agentId"
  | "agentDir"
  | "sessionId"
  | "sessionKey"
  | "runtimePolicySessionKey"
  | "messageProvider"
  | "clientCaps"
  | "toolBindings"
  | "chatType"
  | "agentAccountId"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
  | "spawnedBy"
  | "senderId"
  | "channelContext"
  | "senderName"
  | "senderUsername"
  | "senderE164"
  | "senderIsOwner"
  | "traceAuthorized"
  | "approvalReviewerDeviceId"
  | "sessionFile"
  | "workspaceDir"
  | "cwd"
  | "provider"
  | "model"
  | "hasSessionModelOverride"
  | "modelOverrideSource"
  | "hasAutoFallbackProvenance"
  | "autoFallbackPrimaryProbe"
  | "modelSelectionLocked"
  | "authProfileId"
  | "authProfileIdSource"
  | "thinkLevel"
  | "fastMode"
  | "fastModeAutoOnSeconds"
  | "fastModeOverride"
  | "fastModeAutoOnSecondsOverride"
  | "verboseLevel"
  | "reasoningLevel"
  | "elevatedLevel"
  | "execOverrides"
  | "bashElevated"
  | "timeoutMs"
  | "runTimeoutOverrideMs"
  | "blockReplyBreak"
  | "ownerNumbers"
  | "inputProvenance"
  | "sourceReplyDeliveryMode"
  | "taskSuggestionDeliveryMode"
  | "silentReplyPromptMode"
  | "cliSessionBindingFacts"
  | "enforceFinalTag"
  | "skipProviderRuntimeHints"
  | "silentExpected"
  | "allowEmptyAssistantReplyAsSilent"
  | "suppressNextUserMessagePersistence"
  | "suppressTranscriptOnlyAssistantPersistence"
>;

/**
 * Subset of FollowupRun that can be safely JSON-serialized across restarts.
 * Runtime-only fields (abortSignal, deliveryCorrelations, queuedLifecycle,
 * userTurnTranscriptRecorder) are intentionally excluded. Inbound turn context
 * (event kind, audio flag, current-turn prompt context) is persisted so restored
 * drains rebuild the same prompt envelope after a gateway restart.
 */
type PersistedFollowupRun = Pick<
  FollowupRun,
  | "prompt"
  | "transcriptPrompt"
  | "messageId"
  | "summaryLine"
  | "enqueuedAt"
  | "images"
  | "imageOrder"
  | "media"
  | "currentInboundEventKind"
  | "currentInboundAudio"
  | "currentInboundContext"
  | "originatingChannel"
  | "originatingTo"
  | "originatingAccountId"
  | "originatingThreadId"
  | "originatingReplyToId"
  | "originatingChatId"
  | "originatingReplyToMode"
  | "originatingChatType"
> & {
  run: PersistedRunFields;
};

type PersistedSummaryElision = {
  contextKey: string;
  count: number;
  sources: PersistedFollowupRun[];
  summaryLines: string[];
};

type PersistedQueueEntry = {
  items: PersistedFollowupRun[];
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  summarySources?: PersistedFollowupRun[];
  summaryElisions?: PersistedSummaryElision[];
  evictedSummaryCount?: number;
  lastRun?: PersistedRunFields;
};

const PERSISTED_RUN_FIELDS = [
  "agentId",
  "agentDir",
  "sessionId",
  "sessionKey",
  "runtimePolicySessionKey",
  "messageProvider",
  "clientCaps",
  "toolBindings",
  "chatType",
  "agentAccountId",
  "groupId",
  "groupChannel",
  "groupSpace",
  "spawnedBy",
  "senderId",
  "channelContext",
  "senderName",
  "senderUsername",
  "senderE164",
  "senderIsOwner",
  "traceAuthorized",
  "approvalReviewerDeviceId",
  "sessionFile",
  "workspaceDir",
  "cwd",
  "provider",
  "model",
  "hasSessionModelOverride",
  "modelOverrideSource",
  "hasAutoFallbackProvenance",
  "autoFallbackPrimaryProbe",
  "modelSelectionLocked",
  "authProfileId",
  "authProfileIdSource",
  "thinkLevel",
  "fastMode",
  "fastModeAutoOnSeconds",
  "fastModeOverride",
  "fastModeAutoOnSecondsOverride",
  "verboseLevel",
  "reasoningLevel",
  "elevatedLevel",
  "execOverrides",
  "bashElevated",
  "timeoutMs",
  "runTimeoutOverrideMs",
  "blockReplyBreak",
  "ownerNumbers",
  "inputProvenance",
  "sourceReplyDeliveryMode",
  "taskSuggestionDeliveryMode",
  "silentReplyPromptMode",
  "cliSessionBindingFacts",
  "enforceFinalTag",
  "skipProviderRuntimeHints",
  "silentExpected",
  "allowEmptyAssistantReplyAsSilent",
  "suppressNextUserMessagePersistence",
  "suppressTranscriptOnlyAssistantPersistence",
] as const satisfies ReadonlyArray<keyof PersistedRunFields>;

function projectRunForPersist(run: FollowupRun["run"]): PersistedRunFields {
  const projected: Partial<PersistedRunFields> = {};
  for (const key of PERSISTED_RUN_FIELDS) {
    const value = run[key];
    if (value !== undefined) {
      // Field-by-field copy keeps each value in its source type without
      // forcing a single union onto the projected map's index type.
      (projected as Record<string, unknown>)[key] = value;
    }
  }
  return projected as PersistedRunFields;
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
    return {} as OpenClawConfig;
  }
}

function isPersistedRunFields(value: unknown): value is PersistedRunFields {
  return (
    isRecord(value) &&
    typeof value.agentId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.sessionFile === "string" &&
    typeof value.workspaceDir === "string" &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.timeoutMs === "number" &&
    (value.blockReplyBreak === "text_end" || value.blockReplyBreak === "message_end")
  );
}

function isPersistedFollowupRun(value: unknown): value is PersistedFollowupRun {
  return (
    isRecord(value) &&
    typeof value.prompt === "string" &&
    typeof value.enqueuedAt === "number" &&
    isPersistedRunFields(value.run)
  );
}

function isPersistedSummaryElision(value: unknown): value is PersistedSummaryElision {
  return (
    isRecord(value) &&
    typeof value.contextKey === "string" &&
    typeof value.count === "number" &&
    Array.isArray(value.sources) &&
    value.sources.every(isPersistedFollowupRun) &&
    Array.isArray(value.summaryLines) &&
    value.summaryLines.every((line) => typeof line === "string")
  );
}

function isPersistedQueueEntry(value: unknown): value is PersistedQueueEntry {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isPersistedFollowupRun)
  ) {
    return false;
  }
  if (
    value.summarySources !== undefined &&
    (!Array.isArray(value.summarySources) || !value.summarySources.every(isPersistedFollowupRun))
  ) {
    return false;
  }
  if (
    value.summaryElisions !== undefined &&
    (!Array.isArray(value.summaryElisions) ||
      !value.summaryElisions.every(isPersistedSummaryElision))
  ) {
    return false;
  }
  if (value.evictedSummaryCount !== undefined && typeof value.evictedSummaryCount !== "number") {
    return false;
  }
  return true;
}

/**
 * Drop restored items that cannot be safely reassociated with a session/route.
 * Keeps process-local and incomplete descriptors from hijacking the wrong delivery.
 */
function filterRestorableFollowupItems(queueKey: string, items: FollowupRun[]): FollowupRun[] {
  const restored: FollowupRun[] = [];
  for (const item of items) {
    const sessionKey = normalizeOptionalString(item.run.sessionKey);
    if (sessionKey && sessionKey !== queueKey && !queueKey.startsWith(`${sessionKey}:`)) {
      defaultRuntime.error?.(
        `skipping restored followup for ${queueKey}: sessionKey ${sessionKey} does not match queue key`,
      );
      continue;
    }
    const channel = normalizeOptionalString(item.originatingChannel);
    const to = normalizeOptionalString(item.originatingTo);
    if ((channel && !to) || (!channel && to)) {
      defaultRuntime.error?.(
        `skipping restored followup for ${queueKey}: incomplete originating route (${channel ?? "?"} -> ${to ?? "?"})`,
      );
      continue;
    }
    restored.push(item);
  }
  return restored;
}

function isDeliverablePersistedFollowup(queueKey: string, item: PersistedFollowupRun): boolean {
  const sessionKey = normalizeOptionalString(item.run.sessionKey);
  if (sessionKey && sessionKey !== queueKey && !queueKey.startsWith(`${sessionKey}:`)) {
    return false;
  }
  const channel = normalizeOptionalString(item.originatingChannel);
  const to = normalizeOptionalString(item.originatingTo);
  if ((channel && !to) || (!channel && to)) {
    return false;
  }
  return true;
}

/**
 * True when Doctor can migrate this entry without runtime restore skipping any
 * delivery-bearing source (items, overflow summarySources, or elision sources).
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
  const elisionSources = (value.summaryElisions ?? []).flatMap((elision) => elision.sources);
  return [...value.items, ...summarySources, ...elisionSources].every((item) =>
    isDeliverablePersistedFollowup(queueKey, item),
  );
}

function rehydrateRun(run: PersistedRunFields, currentConfig: OpenClawConfig): FollowupRun["run"] {
  return { ...run, config: currentConfig };
}

function toPersistedRun(item: FollowupRun): PersistedFollowupRun {
  return {
    prompt: item.prompt,
    ...(item.transcriptPrompt !== undefined ? { transcriptPrompt: item.transcriptPrompt } : {}),
    ...(item.messageId !== undefined ? { messageId: item.messageId } : {}),
    ...(item.summaryLine !== undefined ? { summaryLine: item.summaryLine } : {}),
    enqueuedAt: item.enqueuedAt,
    ...(item.images !== undefined ? { images: item.images } : {}),
    ...(item.imageOrder !== undefined ? { imageOrder: item.imageOrder } : {}),
    ...(item.media !== undefined ? { media: item.media } : {}),
    ...(item.currentInboundEventKind !== undefined
      ? { currentInboundEventKind: item.currentInboundEventKind }
      : {}),
    ...(item.currentInboundAudio === true ? { currentInboundAudio: true } : {}),
    ...(item.currentInboundContext !== undefined
      ? { currentInboundContext: item.currentInboundContext }
      : {}),
    ...(item.originatingChannel !== undefined
      ? { originatingChannel: item.originatingChannel }
      : {}),
    ...(item.originatingTo !== undefined ? { originatingTo: item.originatingTo } : {}),
    ...(item.originatingAccountId !== undefined
      ? { originatingAccountId: item.originatingAccountId }
      : {}),
    ...(item.originatingThreadId !== undefined
      ? { originatingThreadId: item.originatingThreadId }
      : {}),
    ...(item.originatingReplyToId !== undefined
      ? { originatingReplyToId: item.originatingReplyToId }
      : {}),
    ...(item.originatingChatId !== undefined ? { originatingChatId: item.originatingChatId } : {}),
    ...(item.originatingReplyToMode !== undefined
      ? { originatingReplyToMode: item.originatingReplyToMode }
      : {}),
    ...(item.originatingChatType !== undefined
      ? { originatingChatType: item.originatingChatType }
      : {}),
    run: projectRunForPersist(item.run),
  };
}

function toPersistedQueueEntry(queue: FollowupQueueState): PersistedQueueEntry {
  return {
    // Keep in-flight identities in SQLite until channel delivery succeeds (or
    // fail-closed discard). Memory inFlight is overflow protection only.
    items: queue.items.map(toPersistedRun),
    lastEnqueuedAt: queue.lastEnqueuedAt,
    mode: queue.mode,
    debounceMs: queue.debounceMs,
    cap: queue.cap,
    dropPolicy: queue.dropPolicy,
    droppedCount: queue.droppedCount,
    summaryLines: queue.summaryLines,
    summarySources: queue.summarySources.map(toPersistedRun),
    summaryElisions: queue.summaryElisions.map((entry) => ({
      contextKey: entry.contextKey,
      count: entry.count,
      sources: entry.sources.map(toPersistedRun),
      summaryLines: entry.summaryLines,
    })),
    evictedSummaryCount: queue.evictedSummaryCount,
    ...(queue.lastRun !== undefined ? { lastRun: projectRunForPersist(queue.lastRun) } : {}),
  };
}

function rehydratePersistedFollowupRun(
  persisted: PersistedFollowupRun,
  currentConfig: OpenClawConfig,
): FollowupRun {
  return {
    ...persisted,
    run: rehydrateRun(persisted.run, currentConfig),
  };
}

/**
 * Write all non-empty followup queues to disk so they survive gateway restarts.
 * Called after any mutation that changes queue contents (enqueue, drain, clear).
 *
 * Rows stay in SQLite until delivery settles (successful channel handoff or
 * fail-closed discard). In-flight marks are process-local only.
 */
export function persistFollowupQueuesOrThrow(): void {
  const entries: Array<[string, PersistedQueueEntry]> = [];
  for (const [key, queue] of FOLLOWUP_QUEUES) {
    if (!queue || (queue.items.length === 0 && queue.droppedCount === 0)) {
      continue;
    }
    entries.push([key, toPersistedQueueEntry(queue)]);
  }
  replaceFollowupQueueEntries({ entries });
}

/**
 * Best-effort persist for non-critical callers (enqueue). Drain settlement uses
 * {@link persistFollowupQueuesOrThrow} so ack failures fail closed.
 */
export function persistFollowupQueues(): void {
  try {
    persistFollowupQueuesOrThrow();
  } catch (err) {
    defaultRuntime.error?.(`failed to persist followup queues: ${String(err)}`);
  }
}

/**
 * Read persisted queue state from disk and populate FOLLOWUP_QUEUES.
 * Called once at module init, before any queue operations.
 */
export function restoreFollowupQueues(): void {
  // Restore exactly once per process. Mark the flag BEFORE doing any work so a
  // concurrent call from a second module evaluation cannot race and replay the
  // restore. If the work below throws, the in-memory state is left in whatever
  // partial-restored shape the loop produced — that is the same shape a clean
  // restore of fewer entries would produce, so it is safe and we still do not
  // want to retry on a later module evaluation.
  if (hasFollowupQueuesRestored()) {
    return;
  }
  markFollowupQueuesRestored();
  try {
    const entries = loadFollowupQueueEntries();
    if (entries.length === 0) {
      return;
    }
    const currentConfig = resolveCurrentRunConfig();
    for (const entry of entries) {
      const key = normalizeOptionalString(Array.isArray(entry) ? entry[0] : undefined);
      const rawData = Array.isArray(entry) ? entry[1] : undefined;
      if (!key || !isPersistedQueueEntry(rawData)) {
        continue;
      }
      const data = rawData;
      const rehydratedItems: FollowupRun[] = filterRestorableFollowupItems(
        key,
        data.items.map((persisted) => ({
          ...persisted,
          run: rehydrateRun(persisted.run, currentConfig),
        })),
      );
      const hasSummaryPayload =
        (data.summarySources?.length ?? 0) > 0 || (data.summaryElisions?.length ?? 0) > 0;
      if (rehydratedItems.length === 0 && data.droppedCount === 0 && !hasSummaryPayload) {
        continue;
      }
      const rehydratedSummarySources = filterRestorableFollowupItems(
        key,
        (data.summarySources ?? []).map((persisted) =>
          rehydratePersistedFollowupRun(persisted, currentConfig),
        ),
      );
      const restored: FollowupQueueState = {
        abortController: new AbortController(),
        items: rehydratedItems,
        draining: false,
        inFlight: new Set(),
        lastEnqueuedAt: typeof data.lastEnqueuedAt === "number" ? data.lastEnqueuedAt : Date.now(),
        mode: normalizeQueueMode(data.mode) ?? "steer",
        debounceMs:
          typeof data.debounceMs === "number"
            ? Math.max(0, data.debounceMs)
            : DEFAULT_QUEUE_DEBOUNCE_MS,
        cap:
          typeof data.cap === "number" && data.cap > 0 ? Math.floor(data.cap) : DEFAULT_QUEUE_CAP,
        dropPolicy: normalizeQueueDropPolicy(data.dropPolicy) ?? DEFAULT_QUEUE_DROP,
        droppedCount:
          typeof data.droppedCount === "number" ? Math.max(0, Math.floor(data.droppedCount)) : 0,
        summaryLines: Array.isArray(data.summaryLines) ? data.summaryLines : [],
        summarySources: rehydratedSummarySources,
        activeSummarySources: new WeakSet(),
        summaryElisions: (data.summaryElisions ?? []).map((elision) => ({
          contextKey: elision.contextKey,
          count: elision.count,
          sources: elision.sources.map((persisted) =>
            rehydratePersistedFollowupRun(persisted, currentConfig),
          ),
          summaryLines: [...elision.summaryLines],
          sourceRefs: new WeakMap(),
        })),
        evictedSummaryCount:
          typeof data.evictedSummaryCount === "number"
            ? Math.max(0, Math.floor(data.evictedSummaryCount))
            : 0,
        ...(isPersistedRunFields(data.lastRun)
          ? { lastRun: rehydrateRun(data.lastRun, currentConfig) }
          : {}),
      };
      FOLLOWUP_QUEUES.set(key, restored);
      const hasPendingRestoredWork =
        restored.items.length > 0 ||
        restored.droppedCount > 0 ||
        restored.summarySources.length > 0;
      if (hasPendingRestoredWork) {
        restoredPendingDrainKeys.add(key);
      }
    }
  } catch (err) {
    defaultRuntime.error?.(`failed to restore followup queues: ${String(err)}`);
  }
}
