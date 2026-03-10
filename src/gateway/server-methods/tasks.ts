import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentCommandFromIngress } from "../../commands/agent.js";
import { defaultRuntime } from "../../runtime.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

// Maximum number of events to keep per task (prevents unbounded growth)
const MAX_TASK_EVENTS = 50;

/**
 * Per-task serialisation queue.
 *
 * Key: taskId
 * Value: tail of the promise chain for that task
 *
 * All tasks.notify calls for the same taskId are chained so that each
 * read-modify-write is strictly sequential — preventing lost updates when
 * two different events (different idempotency keys) are notified concurrently.
 *
 * Per-key idempotency is enforced inside _deliverTaskNotification after the
 * per-task lock is acquired.
 *
 * Since the gateway runs in a single Node.js process this Map is sufficient;
 * no cross-process locking is needed.
 */
const taskNotifyQueue = new Map<string, Promise<unknown>>();

export type TaskWatcher = {
  sessionKey: string;
  label?: string;
  addedAt: number;
};

export type TaskEvent = {
  event: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
};

export type TaskEntry = {
  id: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
  status?: string;
  watchers: TaskWatcher[];
  events: TaskEvent[];
  /** Idempotency map: eventKey → true when that key has been delivered. */
  notifiedEvents: Record<string, boolean>;
};

export type TaskRegistry = {
  tasks: TaskEntry[];
};

// Use getter function so os.homedir() is resolved at call-time, not module-load time.
// This lets tests override HOME before each test without patching a frozen constant.
function getRegistryPath(): string {
  return path.join(os.homedir(), ".openclaw", "task-registry.json");
}

export function loadTaskRegistry(registryPath = getRegistryPath()): TaskRegistry {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch (err: unknown) {
    // File not found → fresh registry (normal for first run)
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { tasks: [] };
    }
    // Permission error, I/O failure, etc. → throw so callers don't overwrite good data
    throw err;
  }
  // Separate try so a JSON parse error is also surfaced rather than silently dropped
  return JSON.parse(raw) as TaskRegistry;
}

export function saveTaskRegistry(registry: TaskRegistry, registryPath = getRegistryPath()): void {
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Atomic write via temp file
  const tmp = `${registryPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  fs.renameSync(tmp, registryPath);
}

/** Callback type injected into deliverTaskNotification for testability. */
export type SendToSessionFn = (sessionKey: string, message: string) => Promise<void>;

/**
 * Inner implementation — do not call directly; use deliverTaskNotification() which
 * serialises concurrent calls for the same (taskId, idempotencyKey) via inFlightNotify.
 */
async function _deliverTaskNotification(opts: {
  taskId: string;
  event: string;
  message: string;
  metadata?: Record<string, unknown>;
  status?: string;
  idempotencyKey?: string;
  registryPath?: string;
  sendToSession: SendToSessionFn;
}): Promise<{ delivered: string[]; failed: string[]; skipped?: string }> {
  const {
    taskId,
    event,
    message,
    metadata,
    status,
    registryPath = getRegistryPath(),
    sendToSession,
  } = opts;

  // Default idempotency key is the event name (fires once per event type by default).
  // Normalize empty/whitespace-only keys to undefined so callers with unset env vars
  // (which produce "") don't accidentally collapse all future notifications.
  const rawKey = opts.idempotencyKey?.trim();
  const ikey = rawKey && rawKey.length > 0 ? rawKey : event;

  const registry = loadTaskRegistry(registryPath);
  const taskIndex = registry.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) {
    return { delivered: [], failed: [], skipped: "task not found" };
  }

  const task = registry.tasks[taskIndex];

  // Idempotency: skip if this key was already delivered
  if (task.notifiedEvents[ikey]) {
    return { delivered: [], failed: [], skipped: "already delivered" };
  }

  const watchers = task.watchers ?? [];
  const delivered: string[] = [];
  const failed: string[] = [];

  for (const watcher of watchers) {
    try {
      await sendToSession(watcher.sessionKey, message);
      delivered.push(watcher.sessionKey);
    } catch {
      // Continue delivering to remaining watchers if one session fails
      failed.push(watcher.sessionKey);
    }
  }

  // Only mark idempotency and log the event if ALL watchers succeeded (or there were none).
  // If any watcher failed, leave the idempotency key unset so the caller can retry — failed
  // watchers will be re-attempted and already-delivered watchers will receive a duplicate,
  // but that is preferable to permanently silencing failed watchers.
  const allSucceeded = failed.length === 0;

  if (!allSucceeded) {
    return { delivered, failed };
  }

  // Build the event log entry (only appended on full success to avoid duplicate log entries)
  const newEvent: TaskEvent = {
    event,
    message,
    ...(metadata ? { metadata } : {}),
    timestamp: Date.now(),
  };

  // Reload registry before writing to pick up any concurrent mutations (watch/unwatch/remove)
  // that may have occurred during the async watcher sends above.
  const freshRegistry = loadTaskRegistry(registryPath);
  const freshIndex = freshRegistry.tasks.findIndex((t) => t.id === taskId);
  if (freshIndex === -1) {
    // Task was removed concurrently; discard — do not resurrect it.
    return { delivered, failed };
  }

  const freshTask = freshRegistry.tasks[freshIndex];

  // Re-check idempotency after reload: a concurrent tasks.notify with the same key may have
  // completed its writes while our fan-out was in flight. Both callers passed the pre-send guard,
  // but only the first writer wins here — the second returns skipped to prevent duplicate delivery.
  if (freshTask.notifiedEvents[ikey]) {
    return { delivered: [], failed: [], skipped: "already delivered" };
  }

  const updatedEvents = [...freshTask.events, newEvent].slice(-MAX_TASK_EVENTS);

  // Merge new idempotency key and cap the map to MAX_TASK_EVENTS entries.
  // Entries are ordered by insertion; when over cap, drop oldest keys first.
  // This prevents registry bloat for long-lived tasks that use unique keys (e.g. commit SHAs).
  const mergedNotified = { ...freshTask.notifiedEvents, [ikey]: true };
  const notifiedKeys = Object.keys(mergedNotified);
  const cappedNotified: Record<string, boolean> =
    notifiedKeys.length > MAX_TASK_EVENTS
      ? Object.fromEntries(notifiedKeys.slice(-MAX_TASK_EVENTS).map((k) => [k, true]))
      : mergedNotified;

  const updatedTask: TaskEntry = {
    ...freshTask,
    updatedAt: Date.now(),
    ...(status !== undefined ? { status } : {}),
    events: updatedEvents,
    notifiedEvents: cappedNotified,
  };

  freshRegistry.tasks[freshIndex] = updatedTask;
  saveTaskRegistry(freshRegistry, registryPath);

  return { delivered, failed };
}

/**
 * Deliver a notification to all watchers of a task.
 *
 * Serialised per taskId: all concurrent notify calls for the same task are
 * queued so each read-modify-write completes before the next begins. This
 * prevents lost event log entries or idempotency marks when two different
 * events arrive simultaneously for the same task.
 *
 * Per-key idempotency is enforced inside _deliverTaskNotification; duplicate
 * calls with the same (taskId, idempotencyKey) return skipped without sending.
 */
export function deliverTaskNotification(
  opts: Parameters<typeof _deliverTaskNotification>[0],
): Promise<ReturnType<typeof _deliverTaskNotification>> {
  const taskId = opts.taskId;

  // Chain onto the existing tail for this task (or start fresh)
  const tail = (taskNotifyQueue.get(taskId) ?? Promise.resolve()).then(() =>
    _deliverTaskNotification(opts),
  );

  // Store the silenced tail so the chain survives errors from inner calls.
  const silentTail = tail.catch(() => undefined);
  taskNotifyQueue.set(taskId, silentTail);

  // Prune map entry when this tail is still the head (no newer call queued).
  void silentTail.then(() => {
    if (taskNotifyQueue.get(taskId) === silentTail) {
      taskNotifyQueue.delete(taskId);
    }
  });

  return tail;
}

export const taskHandlers: GatewayRequestHandlers = {
  /**
   * Create or update a task in the registry.
   * Params: { taskId, description?, metadata?, status? }
   * Returns: { ok: true, task: TaskEntry }
   *
   * curl -s -X POST http://localhost:18789 \
   *   -H 'Content-Type: application/json' \
   *   -d '{"type":"req","id":"1","method":"tasks.register","params":{"taskId":"build-123","description":"Implement feature X"}}'
   */
  "tasks.register": ({ params, respond }) => {
    const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId is required"));
      return;
    }

    const description = typeof params?.description === "string" ? params.description : undefined;
    const metadata =
      params?.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? (params.metadata as Record<string, unknown>)
        : undefined;
    const status = typeof params?.status === "string" ? params.status : undefined;

    const registryPath = getRegistryPath();
    const registry = loadTaskRegistry(registryPath);
    const now = Date.now();

    const existingIndex = registry.tasks.findIndex((t) => t.id === taskId);
    let task: TaskEntry;

    if (existingIndex === -1) {
      // Create new task
      task = {
        id: taskId,
        ...(description !== undefined ? { description } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        ...(status !== undefined ? { status } : {}),
        createdAt: now,
        watchers: [],
        events: [],
        notifiedEvents: {},
      };
      registry.tasks.push(task);
    } else {
      // Update existing task: merge, not replace
      const existing = registry.tasks[existingIndex];
      task = {
        ...existing,
        ...(description !== undefined ? { description } : {}),
        ...(metadata !== undefined ? { metadata: { ...existing.metadata, ...metadata } } : {}),
        ...(status !== undefined ? { status } : {}),
        updatedAt: now,
      };
      registry.tasks[existingIndex] = task;
    }

    saveTaskRegistry(registry, registryPath);
    respond(true, { ok: true, task }, undefined);
  },

  /**
   * Subscribe a session to a task's events.
   * Params: { taskId, sessionKey, label? }
   * Returns: { ok: true, watcherCount: number }
   *
   * curl -s -X POST http://localhost:18789 \
   *   -H 'Content-Type: application/json' \
   *   -d '{"type":"req","id":"2","method":"tasks.watch","params":{"taskId":"build-123","sessionKey":"agent:main:discord:channel:123"}}'
   */
  "tasks.watch": ({ params, respond }) => {
    const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey.trim() : "";
    const label = typeof params?.label === "string" ? params.label : undefined;

    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId is required"));
      return;
    }
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }

    const registryPath = getRegistryPath();
    const registry = loadTaskRegistry(registryPath);
    const taskIndex = registry.tasks.findIndex((t) => t.id === taskId);

    if (taskIndex === -1) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }

    const task = registry.tasks[taskIndex];
    // Idempotent: skip if already watching this session
    const alreadyWatching = task.watchers.some((w) => w.sessionKey === sessionKey);
    if (!alreadyWatching) {
      task.watchers.push({
        sessionKey,
        ...(label ? { label } : {}),
        addedAt: Date.now(),
      });
      registry.tasks[taskIndex] = task;
      saveTaskRegistry(registry, registryPath);
    }

    respond(true, { ok: true, watcherCount: task.watchers.length }, undefined);
  },

  /**
   * Fire an event on a task and deliver the message to all watchers.
   * Params: { taskId, event, message, metadata?, status?, idempotencyKey? }
   * Returns: { ok: true, delivered: string[], failed: string[] }
   *
   * curl -s -X POST http://localhost:18789 \
   *   -H 'Content-Type: application/json' \
   *   -d '{"type":"req","id":"3","method":"tasks.notify","params":{"taskId":"build-123","event":"completed","message":"PR #42 merged","status":"done"}}'
   */
  "tasks.notify": async ({ params, respond, context }) => {
    const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
    const event = typeof params?.event === "string" ? params.event.trim() : "";
    const message = typeof params?.message === "string" ? params.message.trim() : "";
    const metadata =
      params?.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? (params.metadata as Record<string, unknown>)
        : undefined;
    const status = typeof params?.status === "string" ? params.status : undefined;
    const idempotencyKey =
      typeof params?.idempotencyKey === "string" ? params.idempotencyKey.trim() : undefined;

    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId is required"));
      return;
    }
    if (!event) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "event is required"));
      return;
    }
    if (!message) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "message is required"));
      return;
    }

    const registryPath = getRegistryPath();

    // Verify task exists before attempting delivery
    const registry = loadTaskRegistry(registryPath);
    const task = registry.tasks.find((t) => t.id === taskId);
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }

    const sendToSession: SendToSessionFn = async (sk, msg) => {
      await agentCommandFromIngress(
        {
          message: msg,
          sessionKey: sk,
          senderIsOwner: false,
          deliver: false,
          bestEffortDeliver: false,
          messageChannel: INTERNAL_MESSAGE_CHANNEL,
          runContext: { messageChannel: INTERNAL_MESSAGE_CHANNEL },
        },
        defaultRuntime,
        context.deps,
      );
    };

    const result = await deliverTaskNotification({
      taskId,
      event,
      message,
      metadata,
      status,
      idempotencyKey,
      registryPath,
      sendToSession,
    });

    respond(
      true,
      {
        ok: true,
        delivered: result.delivered,
        failed: result.failed,
        ...(result.skipped ? { skipped: result.skipped } : {}),
      },
      undefined,
    );
  },

  /**
   * List registered tasks.
   * Params: { status?, limit? }
   * Returns: { ok: true, tasks: Array<TaskEntry & { watcherCount: number }>, total: number }
   *
   * curl -s -X POST http://localhost:18789 \
   *   -H 'Content-Type: application/json' \
   *   -d '{"type":"req","id":"4","method":"tasks.list","params":{"status":"running"}}'
   */
  "tasks.list": ({ params, respond }) => {
    const statusFilter = typeof params?.status === "string" ? params.status.trim() : undefined;
    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.max(1, Math.floor(params.limit))
        : 50;

    const registry = loadTaskRegistry();
    let tasks = registry.tasks ?? [];

    if (statusFilter) {
      tasks = tasks.filter((t) => t.status === statusFilter);
    }

    const total = tasks.length;
    tasks = tasks.slice(0, limit);

    // Expose watcherCount; strip internal-only fields (watchers array, notifiedEvents)
    const tasksWithCount = tasks.map((t) => {
      const { watchers, notifiedEvents: _notifiedEvents, ...rest } = t;
      return { ...rest, watcherCount: watchers.length };
    });

    respond(true, { ok: true, tasks: tasksWithCount, total }, undefined);
  },

  /**
   * Remove a watcher from a task.
   * Params: { taskId, sessionKey }
   * Returns: { ok: true, watcherCount: number }
   *
   * curl -s -X POST http://localhost:18789 \
   *   -H 'Content-Type: application/json' \
   *   -d '{"type":"req","id":"5","method":"tasks.unwatch","params":{"taskId":"build-123","sessionKey":"agent:main:discord:channel:123"}}'
   */
  "tasks.unwatch": ({ params, respond }) => {
    const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey.trim() : "";

    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId is required"));
      return;
    }
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }

    const registryPath = getRegistryPath();
    const registry = loadTaskRegistry(registryPath);
    const taskIndex = registry.tasks.findIndex((t) => t.id === taskId);

    if (taskIndex === -1) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }

    const task = registry.tasks[taskIndex];
    task.watchers = task.watchers.filter((w) => w.sessionKey !== sessionKey);
    registry.tasks[taskIndex] = task;
    saveTaskRegistry(registry, registryPath);

    respond(true, { ok: true, watcherCount: task.watchers.length }, undefined);
  },

  /**
   * Remove a task from the registry.
   * Params: { taskId }
   * Returns: { ok: true }
   *
   * curl -s -X POST http://localhost:18789 \
   *   -H 'Content-Type: application/json' \
   *   -d '{"type":"req","id":"6","method":"tasks.remove","params":{"taskId":"build-123"}}'
   */
  "tasks.remove": ({ params, respond }) => {
    const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId is required"));
      return;
    }

    const registryPath = getRegistryPath();
    const registry = loadTaskRegistry(registryPath);
    const taskIndex = registry.tasks.findIndex((t) => t.id === taskId);

    if (taskIndex === -1) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }

    registry.tasks.splice(taskIndex, 1);
    saveTaskRegistry(registry, registryPath);

    respond(true, { ok: true }, undefined);
  },
};
