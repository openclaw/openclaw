import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { defaultRuntime } from "../../../runtime.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { normalizeQueueDropPolicy, normalizeQueueMode } from "./normalize.js";
import type { FollowupQueueState, FollowupRun, QueueDropPolicy, QueueMode } from "./types.js";

const FOLLOWUP_QUEUE_STATE_FILENAME = "live-chat-followup-queues.json";

const DEFAULT_QUEUE_DEBOUNCE_MS = 500;
const DEFAULT_QUEUE_CAP = 20;
const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

const FOLLOWUP_QUEUES = resolveGlobalMap<string, FollowupQueueState>(
  Symbol.for("openclaw.followupQueues"),
);

/**
 * Keys of non-empty queues restored from disk on this process start.
 * Entries are removed as drains are scheduled; drain.ts sweeps this set
 * inside rememberFollowupDrainCallback so restored items drain as soon as
 * a valid callback is registered for the queue's channel route.
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

export function resolveFollowupQueueStatePath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, FOLLOWUP_QUEUE_STATE_FILENAME);
}

/**
 * Subset of FollowupRun that can be safely JSON-serialized across restarts.
 * Runtime-only fields (abortSignal, currentTurnContext, deliveryCorrelations,
 * queuedLifecycle) are intentionally excluded.
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
  | "originatingChannel"
  | "originatingTo"
  | "originatingAccountId"
  | "originatingThreadId"
  | "originatingChatType"
  | "run"
>;

type PersistedQueueEntry = {
  items: PersistedFollowupRun[];
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  lastRun?: FollowupRun["run"];
};

function toPersistedRun(item: FollowupRun): PersistedFollowupRun {
  return {
    prompt: item.prompt,
    ...(item.transcriptPrompt !== undefined ? { transcriptPrompt: item.transcriptPrompt } : {}),
    ...(item.messageId !== undefined ? { messageId: item.messageId } : {}),
    ...(item.summaryLine !== undefined ? { summaryLine: item.summaryLine } : {}),
    enqueuedAt: item.enqueuedAt,
    ...(item.images !== undefined ? { images: item.images } : {}),
    ...(item.imageOrder !== undefined ? { imageOrder: item.imageOrder } : {}),
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
    ...(item.originatingChatType !== undefined
      ? { originatingChatType: item.originatingChatType }
      : {}),
    run: item.run,
  };
}

/**
 * Write all non-empty followup queues to disk so they survive gateway restarts.
 * Called after any mutation that changes queue contents (enqueue, drain, clear).
 */
export function persistFollowupQueues(): void {
  try {
    const statePath = resolveFollowupQueueStatePath();
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
          lastRun: queue.lastRun,
        },
      ]);
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    if (entries.length === 0) {
      try {
        fs.unlinkSync(statePath);
      } catch {
        // File may not exist — ignore.
      }
      return;
    }
    // Items can carry user prompts, session ids, and channel routing identifiers,
    // so the state file must be private (0o600) and written atomically — a crash
    // mid-write must not leave a half-written file that breaks restore on next boot.
    const tmpPath = `${statePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
    try {
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({ version: 1, updatedAt: Date.now(), entries }, null, 2),
        { mode: 0o600 },
      );
      fs.renameSync(tmpPath, statePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Temp file may not exist — ignore.
      }
      throw err;
    }
  } catch (err) {
    defaultRuntime.error?.(`failed to persist followup queues: ${String(err)}`);
  }
}

/**
 * Read persisted queue state from disk and populate FOLLOWUP_QUEUES.
 * Called once at module init, before any queue operations.
 */
export function restoreFollowupQueues(): void {
  try {
    const statePath = resolveFollowupQueueStatePath();
    if (!fs.existsSync(statePath)) {
      return;
    }
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      version?: number;
      entries?: unknown;
    };
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    for (const entry of entries) {
      const key = normalizeOptionalString(Array.isArray(entry) ? entry[0] : undefined);
      const data = Array.isArray(entry) ? (entry[1] as Partial<PersistedQueueEntry>) : undefined;
      if (!key || !data || !Array.isArray(data.items)) {
        continue;
      }
      const restored: FollowupQueueState = {
        items: data.items,
        draining: false,
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
        lastRun: data.lastRun,
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
