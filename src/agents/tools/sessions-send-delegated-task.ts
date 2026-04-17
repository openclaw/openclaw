import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";

/**
 * Generic hook for delegated task processing around agent runs.
 * Core does not know about A2A, brokers, or adapters.
 * Implementations are injected at tool creation time.
 */
export interface DelegatedTaskHook {
  /**
   * Pre-run: build extra context to inject into the agent run's system prompt.
   * Return undefined to inject nothing.
   */
  buildContext?(params: DelegatedTaskContextParams): string | undefined;

  /**
   * Post-run: start follow-up processing.
   * The caller intentionally does not await completion, but async hooks are allowed.
   */
  start(params: DelegatedTaskParams): void | Promise<void>;

  /**
   * Optional error hook for failed background starts.
   */
  onError?(params: { error: unknown; task: DelegatedTaskParams }): void;

  /**
   * Reconcile the status of a delegated task against its source of truth.
   * Returns undefined if the task is unknown or reconciliation is not supported.
   */
  reconcileTaskStatus?(params: {
    sessionKey: string;
    taskId: string;
    config?: OpenClawConfig;
  }): Promise<DelegatedTaskStatus | undefined>;

  /**
   * Cancel a delegated task.
   * Returns undefined if the task is unknown or cancellation is not supported.
   */
  cancelTask?(params: {
    sessionKey: string;
    taskId: string;
    reason?: string;
    config?: OpenClawConfig;
  }): Promise<DelegatedTaskCancelResult | undefined>;
}

/**
 * Minimal task status surface exposed through the transport-neutral seam.
 * Implementations map their internal representation to this shape.
 */
export type DelegatedTaskStatus = {
  taskId: string;
  executionStatus: string;
  deliveryStatus: string;
  summary?: string;
  error?: { code: string; message?: string };
  updatedAt: number;
  hasHeartbeat: boolean;
};

/**
 * Cancel result surface exposed through the transport-neutral seam.
 */
export type DelegatedTaskCancelResult = DelegatedTaskStatus & {
  abortStatus?: string;
};

export type DelegatedTaskContextParams = {
  targetSessionKey: string;
  displayKey: string;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
};

export type DelegatedTaskParams = {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
  config?: OpenClawConfig;
};

export function startDelegatedTask(params: {
  hook?: DelegatedTaskHook;
  task: DelegatedTaskParams;
}) {
  const hook = params.hook ?? NOOP_DELEGATED_TASK_HOOK;
  void Promise.resolve(hook.start(params.task)).catch((error) => {
    hook.onError?.({ error, task: params.task });
  });
}

export const NOOP_DELEGATED_TASK_HOOK: DelegatedTaskHook = {
  buildContext() {
    return undefined;
  },
  start() {},
};

/**
 * Reconcile a delegated task's status via the hook, returning undefined
 * when the hook does not support reconciliation or the task is unknown.
 */
export async function reconcileDelegatedTaskStatus(params: {
  hook?: DelegatedTaskHook;
  sessionKey: string;
  taskId: string;
  config?: OpenClawConfig;
}): Promise<DelegatedTaskStatus | undefined> {
  return params.hook?.reconcileTaskStatus?.(params);
}

/**
 * Cancel a delegated task via the hook, returning undefined when
 * the hook does not support cancellation or the task is unknown.
 */
export async function cancelDelegatedTask(params: {
  hook?: DelegatedTaskHook;
  sessionKey: string;
  taskId: string;
  reason?: string;
  config?: OpenClawConfig;
}): Promise<DelegatedTaskCancelResult | undefined> {
  return params.hook?.cancelTask?.(params);
}
