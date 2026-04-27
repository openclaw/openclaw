export type InternalHookEventType = "command" | "session" | "agent" | "gateway" | "message";

export interface InternalHookEvent {
  /** The type of event (command, session, agent, gateway, etc.) */
  type: InternalHookEventType;
  /** The specific action within the type (e.g., 'new', 'reset', 'stop') */
  action: string;
  /** The session key this event relates to */
  sessionKey: string;
  /** Additional context specific to the event */
  context: Record<string, unknown>;
  /** Timestamp when the event occurred */
  timestamp: Date;
  /** Messages to send back to the user (hooks can push to this array) */
  messages: string[];
  /**
   * Deferred actions executed after all internal-hook handlers for this
   * event have completed.
   *
   * Handlers can push callbacks here when they need "act after every other
   * handler has had a chance to mutate event.context" semantics, eliminating
   * FIFO ordering dependencies between handlers. Actions execute in push
   * order; per-action errors are caught and logged but do not block other
   * actions from running.
   *
   * Drain semantics — IMPORTANT for security and correctness:
   *
   * - The drainer takes a snapshot of this array and clears it BEFORE
   *   iterating, so an action that pushes another action onto
   *   event.postHookActions during drain CANNOT extend the current cycle.
   *   Without this guard, a JS for..of iterator over a live array would
   *   re-read length on each step and yield newly appended elements,
   *   creating a self-appending unbounded-execution surface (CWE-834).
   *   Newly pushed actions are queued for a subsequent triggerInternalHook
   *   call, NOT extended into the current drain.
   *
   * - Per-action errors are isolated: a throwing action is logged but does
   *   not prevent later actions from running.
   *
   * - Optional / additive: handlers that don't need this can ignore the
   *   field entirely. Manually constructed events that omit the field are
   *   tolerated by the drainer (??= [] before iteration). Existing handlers
   *   continue to work unchanged.
   *
   * Plugin authors: prefer this pattern when your handler needs to
   *   commit/retract/replace based on the FINAL post-handler state of
   *   event.context, rather than the state at the moment your handler ran.
   */
  postHookActions?: Array<() => Promise<void> | void>;
}

export type InternalHookHandler = (event: InternalHookEvent) => Promise<void> | void;
