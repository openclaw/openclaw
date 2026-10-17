import type { FollowupRun } from "./queue/types.js";
import { runAfterReplyOperationClear, type ReplyOperation } from "./reply-run-registry.js";
import type { TypingController } from "./typing.js";

const typingByReplyOperation = new WeakMap<ReplyOperation, TypingController>();

/** Keep one feedback controller attached to the task that owns a reply run. */
export function bindReplyOperationTyping(
  operation: ReplyOperation,
  typing: TypingController,
): void {
  if (typingByReplyOperation.has(operation)) {
    return;
  }
  typingByReplyOperation.set(operation, typing);
  runAfterReplyOperationClear(operation, () => {
    typingByReplyOperation.delete(operation);
    typing.cleanup();
  });
}

/** Refresh the continuing task's feedback after it adopts another inbound turn. */
export async function refreshReplyOperationTyping(
  operation: ReplyOperation,
  options: { startIfIdle: boolean },
): Promise<void> {
  const typing = typingByReplyOperation.get(operation);
  if (!typing || operation.result || (!options.startIfIdle && !typing.isActive())) {
    return;
  }
  await typing.startTypingLoop();
}

/**
 * The queued item, not the dispatch that queued it, ends its wait: settlement covers
 * execution, cancellation, and removal from the queue. Without a lifecycle nothing
 * would settle typing, so the dispatch keeps it.
 */
export function bindQueuedFollowupTyping(
  followupRun: FollowupRun,
  typing: TypingController,
): boolean {
  const lifecycle = followupRun.turnAdoptionLifecycle;
  if (!lifecycle) {
    return false;
  }
  const onSettled = lifecycle.onSettled;
  lifecycle.onSettled = () => {
    try {
      onSettled?.();
    } finally {
      typing.cleanup();
    }
  };
  return true;
}
