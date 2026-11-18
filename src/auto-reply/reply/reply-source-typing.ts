import {
  createReplyDispatcherWithTyping,
  invokeReplyDispatcherObserver,
} from "./reply-dispatcher.js";
import type { ReplyDispatcherWithTypingOptions } from "./reply-dispatcher.types.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";

/** Keep channel feedback with its source when ingress hands execution to the queue. */
export function createSourceReplyDispatcherWithTyping(params: {
  options: ReplyDispatcherWithTypingOptions;
  runState: ReplyOperationRunState;
}) {
  const { options, runState } = params;
  const onCleanup = options.onCleanup ?? options.typingCallbacks?.onCleanup;
  const queuedOwnsTyping = () =>
    runState.admission?.status === "accepted" && runState.admission.mode === "followup";
  let typingComplete = false;
  let typingCleanedUp = false;
  const cleanupTyping = () => {
    if (!typingCleanedUp) {
      typingCleanedUp = true;
      void invokeReplyDispatcherObserver(() => onCleanup?.());
    }
  };
  const tracked = createReplyDispatcherWithTyping({
    ...options,
    onCleanup: cleanupTyping,
    onIdle: async () => {
      // Delivery finalization must run while a queued source still owns typing.
      if (options.onIdle) {
        await invokeReplyDispatcherObserver(options.onIdle);
      } else if (typingComplete || !queuedOwnsTyping()) {
        await invokeReplyDispatcherObserver(() => options.typingCallbacks?.onIdle?.());
      }
    },
  });
  const finishTyping = () => {
    if (typingComplete) {
      return;
    }
    typingComplete = true;
    tracked.markRunComplete();
    tracked.markDispatchIdle();
    cleanupTyping();
  };
  return {
    dispatcher: tracked.dispatcher,
    replyOptions: tracked.replyOptions,
    completeIngress: () => {
      if (queuedOwnsTyping()) {
        // Native source custody settles once, after retries, adoption, or abandonment.
        void runState.sourceSettlement?.then(finishTyping, finishTyping);
      } else {
        finishTyping();
      }
    },
  };
}
