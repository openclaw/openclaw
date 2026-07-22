import path from "node:path";
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
import type { FollowupQueueState } from "./state.js";
import type { FollowupRun, QueueDropPolicy, QueueMode } from "./types.js";

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
  | "agentAccountId"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
  | "senderId"
  | "senderName"
  | "senderUsername"
  | "senderE164"
  | "senderIsOwner"
  | "traceAuthorized"
  | "sessionFile"
  | "workspaceDir"
  | "cwd"
  | "provider"
  | "model"
  | "hasSessionModelOverride"
  | "modelOverrideSource"
  | "hasAutoFallbackProvenance"
  | "autoFallbackPrimaryProbe"
  | "authProfileId"
  | "authProfileIdSource"
  | "thinkLevel"
  | "verboseLevel"
  | "reasoningLevel"
  | "elevatedLevel"
  | "execOverrides"
  | "bashElevated"
  | "timeoutMs"
  | "blockReplyBreak"
  | "ownerNumbers"
  | "inputProvenance"
  | "sourceReplyDeliveryMode"
  | "silentReplyPromptMode"
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
  | "currentInboundEventKind"
  | "currentInboundAudio"
  | "currentInboundContext"
  | "originatingChannel"
  | "originatingTo"
  | "originatingAccountId"
  | "originatingThreadId"
  | "originatingReplyToId"
  | "originatingChatType"
> & {
  run: PersistedRunFields;
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
  lastRun?: PersistedRunFields;
};

const PERSISTED_RUN_FIELDS = [
  "agentId",
  "agentDir",
  "sessionId",
  "sessionKey",
  "runtimePolicySessionKey",
  "messageProvider",
  "agentAccountId",
  "groupId",
  "groupChannel",
  "groupSpace",
  "senderId",
  "senderName",
  "senderUsername",
  "senderE164",
  "senderIsOwner",
  "traceAuthorized",
  "sessionFile",
  "workspaceDir",
  "cwd",
  "provider",
  "model",
  "hasSessionModelOverride",
  "modelOverrideSource",
  "hasAutoFallbackProvenance",
  "autoFallbackPrimaryProbe",
  "authProfileId",
  "authProfileIdSource",
  "thinkLevel",
  "verboseLevel",
  "reasoningLevel",
  "elevatedLevel",
  "execOverrides",
  "bashElevated",
  "timeoutMs",
  "blockReplyBreak",
  "ownerNumbers",
  "inputProvenance",
  "sourceReplyDeliveryMode",
  "silentReplyPromptMode",
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
    ...(item.originatingChatType !== undefined
      ? { originatingChatType: item.originatingChatType }
      : {}),
    run: projectRunForPersist(item.run),
  };
}

/**
 * Write all non-empty followup queues to disk so they survive gateway restarts.
 * Called after any mutation that changes queue contents (enqueue, drain, clear).
 */
export function persistFollowupQueues(): void {
  try {
    const entries: Array<[string, PersistedQueueEntry]> = [];
    for (const [key, queue] of FOLLOWUP_QUEUES) {
      if (!queue || (queue.items.length === 0 && queue.droppedCount === 0)) {
        continue;
      }
      entries.push([
        key,
        {
          items: queue.items.map(toPersistedRun),
          lastEnqueuedAt: queue.lastEnqueuedAt,
          mode: queue.mode,
          debounceMs: queue.debounceMs,
          cap: queue.cap,
          dropPolicy: queue.dropPolicy,
          droppedCount: queue.droppedCount,
          summaryLines: queue.summaryLines,
          ...(queue.lastRun !== undefined ? { lastRun: projectRunForPersist(queue.lastRun) } : {}),
        },
      ]);
    }
    replaceFollowupQueueEntries({ entries });
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
      const data = Array.isArray(entry) ? (entry[1] as Partial<PersistedQueueEntry>) : undefined;
      if (!key || !data || !Array.isArray(data.items)) {
        continue;
      }
      const rehydratedItems: FollowupRun[] = data.items.map((persisted) => ({
        ...persisted,
        run: rehydrateRun(persisted.run, currentConfig),
      }));
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
        summarySources: [],
        activeSummarySources: new WeakSet(),
        summaryElisions: [],
        evictedSummaryCount: 0,
        ...(data.lastRun !== undefined
          ? { lastRun: rehydrateRun(data.lastRun, currentConfig) }
          : {}),
      };
      FOLLOWUP_QUEUES.set(key, restored);
      if (restored.items.length > 0) {
        restoredPendingDrainKeys.add(key);
      }
    }
  } catch (err) {
    defaultRuntime.error?.(`failed to restore followup queues: ${String(err)}`);
  }
}
