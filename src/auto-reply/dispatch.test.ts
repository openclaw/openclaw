import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ReplyPayload } from "./types.js";
const dispatchFromConfigMock = vi.hoisted(() => ({
  dispatchReplyFromConfig: vi.fn(),
}));

vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: dispatchFromConfigMock.dispatchReplyFromConfig,
}));

import {
  dispatchInboundMessage,
  dispatchInboundMessageWithBufferedDispatcher,
  withReplyDispatcher,
} from "./dispatch.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import { buildTestCtx } from "./reply/test-ctx.js";

function createDispatcher(record: string[]): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {
      record.push("markComplete");
    },
    waitForIdle: async () => {
      record.push("waitForIdle");
    },
  };
}

describe("withReplyDispatcher", () => {
  beforeEach(() => {
    dispatchFromConfigMock.dispatchReplyFromConfig.mockReset();
    dispatchFromConfigMock.dispatchReplyFromConfig.mockImplementation(async (params) => {
      const reply = await params.replyResolver?.(params.ctx, params.replyOptions);
      const replies = reply ? (Array.isArray(reply) ? reply : [reply]) : [];
      for (const payload of replies) {
        params.dispatcher.sendFinalReply(payload as ReplyPayload);
      }
      return {
        queuedFinal: replies.length > 0,
        counts: params.dispatcher.getQueuedCounts(),
      };
    });
  });

  it("always marks complete and waits for idle after success", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);

    const result = await withReplyDispatcher({
      dispatcher,
      run: async () => {
        order.push("run");
        return "ok";
      },
      onSettled: () => {
        order.push("onSettled");
      },
    });

    expect(result).toBe("ok");
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("still drains dispatcher after run throws", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);
    const onSettled = vi.fn(() => {
      order.push("onSettled");
    });

    await expect(
      withReplyDispatcher({
        dispatcher,
        run: async () => {
          order.push("run");
          throw new Error("boom");
        },
        onSettled,
      }),
    ).rejects.toThrow("boom");

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("dispatchInboundMessage waits for idle before deferred callbacks run", async () => {
    const order: string[] = [];
    let resolveIdle: (() => void) | undefined;
    const dispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => {
        order.push("sendFinalReply");
        return true;
      },
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 1 }),
      getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {
        order.push("markComplete");
      },
      waitForIdle: async () => {
        order.push("waitForIdle:start");
        await new Promise<void>((resolve) => {
          resolveIdle = resolve;
        });
        order.push("waitForIdle:end");
      },
    } satisfies ReplyDispatcher;
    dispatchFromConfigMock.dispatchReplyFromConfig.mockImplementationOnce(async (params) => {
      params.dispatcher.sendFinalReply({ text: "ok" });
      params.replyOptions?.registerAfterFinalDelivery?.(() => {
        order.push("afterFinalDelivery");
      });
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
    });

    const dispatchPromise = dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher,
    });

    await Promise.resolve();
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle:start"]);

    resolveIdle?.();
    await dispatchPromise;

    expect(order).toEqual([
      "sendFinalReply",
      "markComplete",
      "waitForIdle:start",
      "waitForIdle:end",
      "afterFinalDelivery",
    ]);
  });

  it("dispatchInboundMessage skips deferred callbacks when final delivery never succeeds", async () => {
    const order: string[] = [];
    const dispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => {
        order.push("sendFinalReply");
        return true;
      },
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 1 }),
      getFailedCounts: () => ({ tool: 0, block: 0, final: 1 }),
      markComplete: () => {
        order.push("markComplete");
      },
      waitForIdle: async () => {
        order.push("waitForIdle");
      },
    } satisfies ReplyDispatcher;
    dispatchFromConfigMock.dispatchReplyFromConfig.mockImplementationOnce(async (params) => {
      params.dispatcher.sendFinalReply({ text: "ok" });
      params.replyOptions?.registerAfterFinalDelivery?.(() => {
        const delivered =
          params.dispatcher.getQueuedCounts().final - params.dispatcher.getFailedCounts().final;
        if (delivered <= 0) {
          return;
        }
        order.push("afterFinalDelivery");
      });
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
    });

    await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher,
    });

    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("dispatchInboundMessageWithBufferedDispatcher cleans up typing after a resolver starts it", async () => {
    const typing = {
      onReplyStart: vi.fn(async () => {}),
      startTypingLoop: vi.fn(async () => {}),
      startTypingOnText: vi.fn(async () => {}),
      refreshTypingTtl: vi.fn(),
      isActive: vi.fn(() => true),
      markRunComplete: vi.fn(),
      markDispatchIdle: vi.fn(),
      cleanup: vi.fn(),
    };

    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        deliver: async () => undefined,
      },
      replyResolver: async (_ctx, opts) => {
        opts?.onTypingController?.(typing);
        return { text: "ok" };
      },
    });

    expect(typing.markRunComplete).toHaveBeenCalledTimes(1);
    expect(typing.markDispatchIdle).toHaveBeenCalled();
  });
});
