/**
 * Public enqueue knobs shared by command-lane callers and narrower injection
 * points that should not import the full queue implementation.
 */
export type CommandQueueEnqueueOptions = {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  taskTimeoutAbortSignal?: AbortSignal;
  taskTimeoutAbortGraceMs?: number;
  /** Ends the task after a caller-owned timeout cleanup grace has already elapsed. */
  taskTimeoutReleaseSignal?: AbortSignal;
  priority?: "foreground" | "normal" | "background";
  /**
   * Keep this many lane slots free for entries at or above the given priority.
   *
   * Example: `{ slots: 1, priority: "foreground" }` lets foreground work use
   * the final lane slot while normal/background work waits.
   */
  reserveForPriority?: {
    slots: number;
    priority: "foreground" | "normal" | "background";
  };
};

/** Minimal queue function contract used by code that only needs to schedule work. */
export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
) => Promise<T>;
