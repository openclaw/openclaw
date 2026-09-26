// @vitest-environment node
import { expect, it, onTestFinished, vi } from "vitest";
import { makeChatHost } from "./chat-host.test-support.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { scheduleChatScroll } from "./scroll.ts";

useChatSendBrowserFixture();

it("retires queued and committed fixture effects and rejects late scheduling", async () => {
  const cleanup = vi.fn();
  const committedCancel = vi.fn();
  const completedCancel = vi.fn();
  const pendingCancel = vi.fn();
  const pendingEffect = vi.fn();
  const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame");
  let queuedCommit: VoidFunction | undefined;

  // Vitest retires fixtures in reverse registration order, before this verification.
  onTestFinished(async () => {
    expect(cleanup).toHaveBeenCalledOnce();
    expect(committedCancel).not.toHaveBeenCalled();
    expect(completedCancel).not.toHaveBeenCalled();
    expect(pendingCancel).toHaveBeenCalledOnce();
    expect(cancelFrame).toHaveBeenCalledOnce();
    queuedCommit?.();
    expect(pendingEffect).not.toHaveBeenCalled();
    cancelPending();
    expect(pendingCancel).toHaveBeenCalledOnce();

    const lateEffect = vi.fn();
    const lateCancel = vi.fn();
    host.renderLifecycle.afterCommit(lateEffect, lateCancel);
    await Promise.resolve();
    expect(lateEffect).not.toHaveBeenCalled();
    expect(lateCancel).toHaveBeenCalledOnce();
  });
  const host = makeChatHost();
  host.renderLifecycle.afterCommit(() => cleanup, committedCancel);
  host.renderLifecycle.afterCommit((complete) => complete(), completedCancel);
  scheduleChatScroll(host);
  await Promise.resolve();

  const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
    queuedCommit = callback;
  });
  let cancelPending: () => void;
  try {
    cancelPending = host.renderLifecycle.afterCommit(pendingEffect, pendingCancel);
  } finally {
    queue.mockRestore();
  }
});
