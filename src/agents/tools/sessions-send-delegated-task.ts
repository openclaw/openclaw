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
}

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
