import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import { clearInternalHooks, registerInternalHook } from "../hooks/internal-hooks.js";
import { dispatchInboundMessage, withReplyDispatcher } from "./dispatch.js";
import { buildTestCtx } from "./reply/test-ctx.js";

function createDispatcher(record: string[]): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {
      record.push("markComplete");
    },
    waitForIdle: async () => {
      record.push("waitForIdle");
    },
  };
}

describe("message:received hook regression", () => {
  beforeEach(() => {
    clearInternalHooks();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  it("dispatchInboundMessage triggers message:received hook before processing", async () => {
    const hookHandler = vi.fn();
    registerInternalHook("message:received", hookHandler);

    const order: string[] = [];
    const dispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => {
        order.push("sendFinalReply");
        return true;
      },
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {
        order.push("markComplete");
      },
      waitForIdle: async () => {
        order.push("waitForIdle");
      },
    } satisfies ReplyDispatcher;

    await dispatchInboundMessage({
      ctx: buildTestCtx({ Body: "test message", Provider: "signal" }),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "ok" }),
    });

    // Hook MUST fire — this is the regression test for the upstream refactor
    // that silently dropped the triggerMessageReceived() call (commit d5e25e0ad).
    expect(hookHandler).toHaveBeenCalledTimes(1);

    const event = hookHandler.mock.calls[0][0];
    expect(event.type).toBe("message");
    expect(event.action).toBe("received");
    expect(event.context.message).toBe("test message");
    expect(event.context.channel).toBe("signal");
  });
});

describe("withReplyDispatcher", () => {
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

  it("dispatchInboundMessage owns dispatcher lifecycle", async () => {
    const order: string[] = [];
    const dispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => {
        order.push("sendFinalReply");
        return true;
      },
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {
        order.push("markComplete");
      },
      waitForIdle: async () => {
        order.push("waitForIdle");
      },
    } satisfies ReplyDispatcher;

    await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });
});
