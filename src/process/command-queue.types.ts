/**
 * Public enqueue knobs shared by command-lane callers and narrower injection
 * points that should not import the full queue implementation.
 */
export type CommandQueueEnqueueOptions = {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  priority?: "foreground" | "normal" | "background";
  /**
   * Internal continuation escape hatch for work that already owns a logical
   * active turn before gateway drain begins. Do not set for new user work.
   */
  allowGatewayDrainingContinuation?: boolean;
};

/** Minimal queue function contract used by code that only needs to schedule work. */
export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
) => Promise<T>;
