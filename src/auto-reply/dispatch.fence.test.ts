/** Tests foreground reply fence concurrency: older active generations should not be
 *  cancelled just because a newer generation produced a visible delivery. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearForegroundReplyFenceForTest,
  dispatchInboundMessageWithBufferedDispatcher,
} from "./dispatch.js";
import type { DispatchFromConfigParams } from "./reply/dispatch-from-config.types.js";
import { buildTestCtx } from "./reply/test-ctx.js";

type DispatchReplyFromConfigFn =
  typeof import("./reply/dispatch-from-config.js").dispatchReplyFromConfig;

const hoisted = vi.hoisted(() => ({
  dispatchReplyFromConfigMock: vi.fn<DispatchReplyFromConfigFn>(),
}));

vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: (...args: Parameters<DispatchReplyFromConfigFn>) =>
    hoisted.dispatchReplyFromConfigMock(...args),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: vi.fn(() => false),
    runMessageSending: vi.fn(async () => undefined),
    runReplyPayloadSending: vi.fn(async () => undefined),
  })),
}));

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sharedCtx() {
  return buildTestCtx({
    SessionKey: "agent:test:session",
    Surface: "telegram",
    Provider: "telegram",
    From: "telegram:user-1",
    To: "telegram:chat-1",
    ChatType: "direct",
  });
}

describe("foreground reply fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearForegroundReplyFenceForTest();
  });

  it("does not cancel an older in-flight generation when a newer generation delivers visibly", async () => {
    const aStarted = createDeferred();
    const aCanFinish = createDeferred();
    const aDelivered = createDeferred();
    const bDelivered = createDeferred();

    const aDeliver = vi.fn(async () => {
      aDelivered.resolve();
      return { visibleReplySent: true };
    });
    const bDeliver = vi.fn(async () => {
      bDelivered.resolve();
      return { visibleReplySent: true };
    });

    // Generation A begins first but waits to enqueue its reply until generation B has started.
    hoisted.dispatchReplyFromConfigMock.mockImplementationOnce(
      async ({ dispatcher }: DispatchFromConfigParams) => {
        await aStarted.promise;
        dispatcher.sendFinalReply({ text: "reply A" });
        await aCanFinish.promise;
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    // Generation B enqueues its reply immediately.
    hoisted.dispatchReplyFromConfigMock.mockImplementationOnce(
      async ({ dispatcher }: DispatchFromConfigParams) => {
        dispatcher.sendFinalReply({ text: "reply B" });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    const aPromise = dispatchInboundMessageWithBufferedDispatcher({
      ctx: sharedCtx(),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: { deliver: aDeliver },
      replyResolver: async () => ({ text: "reply A" }),
    });

    // Let generation A proceed just far enough to create its fence snapshot.
    aStarted.resolve();

    const bPromise = dispatchInboundMessageWithBufferedDispatcher({
      ctx: sharedCtx(),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: { deliver: bDeliver },
      replyResolver: async () => ({ text: "reply B" }),
    });

    // Wait for B's visible delivery to update the shared fence state.
    await bDelivered.promise;

    // Now let generation A's run finish; its delivery should still go through.
    aCanFinish.resolve();
    await aDelivered.promise;

    await Promise.all([aPromise, bPromise]);

    expect(aDeliver).toHaveBeenCalledTimes(1);
    expect(bDeliver).toHaveBeenCalledTimes(1);
  });
});
