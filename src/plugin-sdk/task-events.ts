/**
 * Plugin SDK seam for subscribing to task registry lifecycle events.
 *
 * Use `addTaskRegistryEventListener` to react to task transitions (queued,
 * running, terminal). Listeners run inside the registry's emit path, so they
 * must be quick and non-blocking — schedule any heavy work onto a microtask
 * or background queue. Exceptions thrown from a listener are swallowed so
 * one consumer cannot break the registry's notification path.
 *
 * The seam intentionally mirrors the internal observer event shape so that
 * plugins do not need to keep up with the singleton observer wiring used by
 * tests.
 */
export {
  addTaskRegistryEventListener,
  type TaskRegistryObserverEvent,
} from "../tasks/task-registry.store.js";
export type {
  TaskDeliveryStatus,
  TaskEventKind,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRuntime,
  TaskScopeKind,
  TaskStatus,
  TaskTerminalOutcome,
} from "../tasks/task-registry.types.js";
