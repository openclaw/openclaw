import { expect, it, vi } from "vitest";
import { createTypingCallbacks } from "../../channels/typing.js";
import { createReplyDispatcherWithTyping } from "./reply-dispatcher.js";
import { createTypingController } from "./typing.js";

async function flushTypingStop(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

it("lets a queued follow-up start typing after the source dispatch settles", async () => {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const callbacks = createTypingCallbacks({
    start,
    stop,
    onStartError: () => undefined,
  });
  const typing = createTypingController({
    onReplyStart: callbacks.onReplyStart,
    onCleanup: callbacks.onCleanup,
    typingIntervalSeconds: 0,
  });
  const lifecycle = createReplyDispatcherWithTyping({
    deliver: async () => undefined,
    typingCallbacks: callbacks,
  });
  lifecycle.replyOptions.onTypingController?.(typing);

  typing.holdForQueuedFollowup?.();
  lifecycle.markRunComplete();
  lifecycle.markDispatchIdle();
  await typing.startTypingLoop();
  expect(start).toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();

  typing.releaseQueuedFollowupHold?.();
  typing.markRunComplete();
  typing.markDispatchIdle();
  await flushTypingStop();
  expect(stop).toHaveBeenCalled();
});
