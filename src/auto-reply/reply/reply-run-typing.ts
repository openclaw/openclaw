import {
  runAfterReplyOperationClear,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import type { FollowupRun } from "./queue/types.js";
import type { TypingSignaler } from "./typing-mode.js";
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
  typingSignals: TypingSignaler,
): (queuedBehindActiveRun: boolean, onHandoff?: () => void) => Promise<void> {
  followupRun.typing = typing;
  const lifecycle = followupRun.turnAdoptionLifecycle;
  if (lifecycle) {
    const onSettled = lifecycle.onSettled;
    lifecycle.onSettled = () => {
      try {
        return onSettled?.();
      } finally {
        typing.cleanup();
      }
    };
  }
  return async (queuedBehindActiveRun, onHandoff) => {
    if (!queuedBehindActiveRun) {
      typing.cleanup();
      return;
    }
    await typingSignals.signalToolStart();
    if (lifecycle && typing.isActive()) {
      onHandoff?.();
    }
  };
}
