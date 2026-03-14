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
 * Key: registryPath (absolute path to task-registry.json)
 * Value: tail of the promise chain for that registry file
 *
 * The registry is a SINGLE FILE containing all tasks.  Locking per-task is
 * insufficient because two concurrent notify calls for *different* tasks
 * both do read-modify-write on the same file and the later save overwrites
 * the earlier one, losing an event log entry or idempotency mark.
 *
 * Serialising on the registry path ensures at most one task's write is in
 * flight at any time, making the read-modify-write atomic from the
 * perspective of the Node.js event loop.
 *
 * Per-key idempotency is enforced inside _deliverTaskNotification after the
 * registry lock is acquired.
 *
 * Since the gateway runs in a single Node.js process this Map is sufficient;
 * no cross-process locking is needed.
 */
const registryWriteQueue = new Map<string, Promise<unknown>>();

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
 * Run `fn` as the next step on the registry write queue for `registryKey`.
 * Only the synchronous body of `fn` (a single registry read-modify-write)
 * should be placed inside; async fan-out must happen outside.
 */
function withRegistryLock<T>(registryKey: string, fn: () => T): Promise<T> {
  const tail = (registryWriteQueue.get(registryKey) ?? Promise.resolve()).then(fn);
  const silentTail = tail.catch(() => undefined);
  registryWriteQueue.set(registryKey, silentTail);
  void silentTail.then(() => {
    if (registryWriteQueue.get(registryKey) === silentTail) {
      registryWriteQueue.delete(registryKey);
    }
  });
  return tail;
}

/**
 * Deliver a notification to all watchers of a task.
 *
 * The registry lock is held only for the two short critical sections:
 *   1. Pre-flight: read registry, check idempotency, extract watcher list.
 *   2. Post-flight: reload registry, re-check idempotency, write update.
 * Fan-out (sendToSession calls) runs between them, outside the lock, so a
 * slow or hung watcher on task A never blocks task B from starting.
 *
 * Idempotency guarantee: concurrent calls with the same (taskId, ikey) may
 * both fan-out (duplicate delivery is acceptable), but only the first
 * post-flight write succeeds — the second detects the key and returns skipped.
 * For concurrent calls on *different* tasks, both writes land correctly because
 * each post-flight section holds the lock exclusively.
 */
export async function deliverTaskNotification(opts: {
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

  // Normalize idempotency key: empty/whitespace falls back to event name.
  const rawKey = opts.idempotencyKey?.trim();
  const ikey = rawKey && rawKey.length > 0 ? rawKey : event;

  const registryKey = registryPath;

  // ── Critical section 1: pre-flight read + idempotency check ─────────────
  const preCheck = await withRegistryLock(registryKey, () => {
    const registry = loadTaskRegistry(registryPath);
    const task = registry.tasks.find((t) => t.id === taskId);
    if (!task) {
      return { skip: "task not found" as const, watchers: [] };
    }
    if (Object.hasOwn(task.notifiedEvents, ikey)) {
      return { skip: "already delivered" as const, watchers: [] };
    }
    return { skip: null, watchers: task.watchers ?? [] };
  });

  if (preCheck.skip !== null) {
    return { delivered: [], failed: [], skipped: preCheck.skip };
  }

  // ── Fan-out: outside the lock ────────────────────────────────────────────
  const delivered: string[] = [];
  const failed: string[] = [];

  for (const watcher of preCheck.watchers) {
    try {
      await sendToSession(watcher.sessionKey, message);
      delivered.push(watcher.sessionKey);
    } catch {
      failed.push(watcher.sessionKey);
    }
  }

  // Only persist if all watchers succeeded (or there were none).
  // Partial failure leaves the idempotency key unset so callers can retry.
  if (failed.length > 0) {
    return { delivered, failed };
  }

  // ── Critical section 2: post-flight reload + write ───────────────────────
  return withRegistryLock(registryKey, () => {
    const freshRegistry = loadTaskRegistry(registryPath);
    const freshIndex = freshRegistry.tasks.findIndex((t) => t.id === taskId);

    if (freshIndex === -1) {
      // Task removed concurrently — discard without resurrecting.
      return { delivered, failed };
    }

    const freshTask = freshRegistry.tasks[freshIndex];

    // Re-check: a concurrent call with the same key may have written while
    // our fan-out was in flight.
    if (Object.hasOwn(freshTask.notifiedEvents, ikey)) {
      return { delivered: [], failed: [], skipped: "already delivered" as const };
    }

    const newEvent: TaskEvent = {
      event,
      message,
      ...(metadata ? { metadata } : {}),
      timestamp: Date.now(),
    };

    const updatedEvents = [...freshTask.events, newEvent].slice(-MAX_TASK_EVENTS);

    // Cap notifiedEvents to MAX_TASK_EVENTS, dropping oldest keys first.
    const mergedNotified = { ...freshTask.notifiedEvents, [ikey]: true };
    const notifiedKeys = Object.keys(mergedNotified);
    const cappedNotified: Record<string, boolean> =
      notifiedKeys.length > MAX_TASK_EVENTS
        ? Object.fromEntries(notifiedKeys.slice(-MAX_TASK_EVENTS).map((k) => [k, true]))
        : mergedNotified;

    freshRegistry.tasks[freshIndex] = {
      ...freshTask,
      updatedAt: Date.now(),
      ...(status !== undefined ? { status } : {}),
      events: updatedEvents,
      notifiedEvents: cappedNotified,
    };

    saveTaskRegistry(freshRegistry, registryPath);
    return { delivered, failed };
  });
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
