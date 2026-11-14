import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "../auto-reply/reply/reply-dispatcher.types.js";
import { settlesWithin } from "../shared/settle-within.js";
import type { ReplyOperation } from "./session-controller.contracts.js";
import { REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS } from "./session-controller.contracts.js";
import { resolveReplyRunForCurrentSessionId } from "./session-controller.identity.js";
import { producerCompletionByOperation } from "./session-controller.storage.js";

/** Source release follows producer completion or the owner's terminal fencing receipt. */
export function waitForReplyOperationSourceRelease(operation: ReplyOperation): Promise<unknown> {
  const producerCompletion = producerCompletionByOperation.get(operation);
  return producerCompletion
    ? Promise.race([producerCompletion, operation.ownerSettlement])
    : operation.ownerSettlement;
}

export function waitForReplyBarrierSettlement(
  barrier: PromiseLike<unknown>,
  timeout: number | ReplyFollowupAdmissionBarrierTimeoutPolicy = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
): Promise<void> {
  // Owners may extend this for bounded retry envelopes; all barriers retain a failsafe.
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const schedule = (delayMs: number, callback: () => void) => {
      timer = setTimeout(callback, delayMs);
      timer.unref?.();
    };
    if (typeof timeout === "number") {
      schedule(resolveTimerTimeoutMs(timeout, REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS), finish);
    } else {
      const startedAt = performance.now();
      const maxTimeoutMs = resolveTimerTimeoutMs(
        timeout.maxTimeoutMs,
        REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
      );
      const shouldExtend = () => {
        try {
          return timeout.shouldExtend();
        } catch {
          return false;
        }
      };
      const checkOwnerActivity = () => {
        const remainingMs = maxTimeoutMs - (performance.now() - startedAt);
        if (remainingMs <= 0 || !shouldExtend()) {
          finish();
          return;
        }
        schedule(Math.min(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, remainingMs), checkOwnerActivity);
      };
      schedule(Math.min(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, maxTimeoutMs), checkOwnerActivity);
    }
    void Promise.resolve(barrier).then(finish, finish);
  });
}

export async function waitForReplyOperationOwnerSettlement(
  operation: ReplyOperation,
  timeoutMs: number,
): Promise<boolean> {
  return await settlesWithin(operation.ownerSettlement, resolveTimerTimeoutMs(timeoutMs, 100, 100));
}

export function waitForReplyRunEndBySessionId(
  sessionId: string,
  timeoutMs?: number | null,
): Promise<boolean> {
  const resolution = resolveReplyRunForCurrentSessionId(sessionId);
  if (resolution.kind === "none") {
    return Promise.resolve(true);
  }
  const operations = resolution.kind === "one" ? [resolution.operation] : resolution.operations;
  return Promise.all(
    operations.map((operation) =>
      timeoutMs === null
        ? operation.ownerSettlement.then(() => true)
        : waitForReplyOperationOwnerSettlement(
            operation,
            timeoutMs ?? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
          ),
    ),
  ).then((outcomes) => outcomes.every(Boolean));
}
