export type CommandQueueEnqueueOptions = {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  taskTimeoutMs?: number;
  allowDuringGatewayDrain?: boolean;
  taskTimeoutProgressAtMs?: () => number | undefined;
  priority?: "foreground" | "normal" | "background";
};

export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
) => Promise<T>;
