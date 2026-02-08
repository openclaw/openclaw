/**
 * Priority-aware hook registration for the internal hook system.
 *
 * Wraps the existing `registerInternalHook` / `triggerInternalHook` API
 * and adds deterministic execution ordering via numeric priorities.
 *
 * Lower priority numbers run first:
 *   security (1) → core (10) → plugins (50) → logging (100)
 *
 * Handlers with the same priority preserve registration order.
 *
 * Usage:
 * ```ts
 * import { registerPriorityHook, triggerPriorityHook } from "./priority-hooks.js";
 *
 * registerPriorityHook("command:new", handler, { priority: 1, label: "security" });
 * registerPriorityHook("command:new", handler, { priority: 100, label: "logging" });
 *
 * await triggerPriorityHook(event); // security runs before logging
 * ```
 */

import type { InternalHookEvent, InternalHookHandler } from "./internal-hooks.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PriorityHookOptions = {
  /** Execution priority. Lower = earlier. Default: 50 */
  priority?: number;
  /** Human-readable label for debugging */
  label?: string;
  /** Fire once then auto-unregister */
  once?: boolean;
};

export type PriorityHookEntry = {
  id: string;
  handler: InternalHookHandler;
  priority: number;
  label: string | undefined;
  once: boolean;
  /** Monotonic insertion index for stable ordering within the same priority */
  _insertionIdx: number;
};

export type PriorityHookStats = {
  events: number;
  handlers: number;
  totalEmits: number;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, PriorityHookEntry[]>();
const emitCounts = new Map<string, number>();
let idCounter = 0;

/**
 * Register a hook handler with priority ordering.
 *
 * @returns A unique ID that can be passed to `unregisterPriorityHook`.
 */
export function registerPriorityHook(
  eventKey: string,
  handler: InternalHookHandler,
  options: PriorityHookOptions = {},
): string {
  const id = `phook_${++idCounter}`;
  const entry: PriorityHookEntry = {
    id,
    handler,
    priority: options.priority ?? 50,
    label: options.label,
    once: options.once ?? false,
    _insertionIdx: idCounter,
  };

  const list = registry.get(eventKey) ?? [];
  list.push(entry);
  // Sort by priority, then by insertion order for deterministic equal-priority behavior
  list.sort((a, b) => a.priority - b.priority || a._insertionIdx - b._insertionIdx);
  registry.set(eventKey, list);

  return id;
}

/**
 * Register a one-shot priority hook. Auto-removed after first invocation.
 */
export function oncePriorityHook(
  eventKey: string,
  handler: InternalHookHandler,
  priority?: number,
): string {
  return registerPriorityHook(eventKey, handler, { priority, once: true });
}

/**
 * Remove a specific handler by ID.
 *
 * @returns `true` if the handler was found and removed.
 */
export function unregisterPriorityHook(eventKey: string, hookId: string): boolean {
  const list = registry.get(eventKey);
  if (!list) return false;

  const idx = list.findIndex((e) => e.id === hookId);
  if (idx === -1) return false;

  list.splice(idx, 1);
  if (list.length === 0) registry.delete(eventKey);
  return true;
}

/**
 * Trigger all priority hooks matching the event.
 *
 * Resolves both the general type key (`"command"`) and the specific
 * `"type:action"` key, merges them, sorts by priority, then executes
 * sequentially.  Errors are caught per-handler so one failure does not
 * block the rest.
 *
 * @returns Array of errors thrown by handlers (empty if all succeeded).
 */
export async function triggerPriorityHook(event: InternalHookEvent): Promise<Error[]> {
  const typeHandlers = registry.get(event.type) ?? [];
  const specificHandlers = registry.get(`${event.type}:${event.action}`) ?? [];

  // Merge, de-duplicate by ID, and sort by priority + insertion order
  const seen = new Set<string>();
  const merged: PriorityHookEntry[] = [];
  for (const entry of [...typeHandlers, ...specificHandlers]) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      merged.push(entry);
    }
  }
  const all = merged.sort((a, b) => a.priority - b.priority || a._insertionIdx - b._insertionIdx);

  if (all.length === 0) return [];

  // Track emit
  const key = `${event.type}:${event.action}`;
  emitCounts.set(key, (emitCounts.get(key) ?? 0) + 1);

  const errors: Error[] = [];
  const toRemove: Array<{ eventKey: string; id: string }> = [];

  for (const entry of all) {
    try {
      await entry.handler(event);
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
    if (entry.once) {
      // Figure out which key this entry belongs to
      const ownerKey = typeHandlers.includes(entry) ? event.type : `${event.type}:${event.action}`;
      toRemove.push({ eventKey: ownerKey, id: entry.id });
    }
  }

  // Clean up once-handlers
  for (const { eventKey, id } of toRemove) {
    unregisterPriorityHook(eventKey, id);
  }

  return errors;
}

/**
 * List registered handlers for a given event key, sorted by priority.
 */
export function listPriorityHooks(
  eventKey: string,
): Array<{ id: string; priority: number; label: string | undefined }> {
  return (registry.get(eventKey) ?? []).map((e) => ({
    id: e.id,
    priority: e.priority,
    label: e.label,
  }));
}

/**
 * Get aggregate statistics.
 */
export function getPriorityHookStats(): PriorityHookStats {
  let handlers = 0;
  for (const list of registry.values()) handlers += list.length;
  return {
    events: registry.size,
    handlers,
    totalEmits: [...emitCounts.values()].reduce((a, b) => a + b, 0),
  };
}

/**
 * Clear all priority hooks and counters. Useful for testing.
 */
export function clearPriorityHooks(): void {
  registry.clear();
  emitCounts.clear();
  idCounter = 0;
}
