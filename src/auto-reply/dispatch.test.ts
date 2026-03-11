import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as hookRunnerGlobal from "../plugins/hook-runner-global.js";
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
    markComplete: () => {
      record.push("markComplete");
    },
    waitForIdle: async () => {
      record.push("waitForIdle");
    },
  };
}

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

  it("derives channel context for buffered dispatcher message hooks", async () => {
    const runMessageSending = vi.fn().mockResolvedValue(undefined);
    const hookRunner = {
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    };
    const hookSpy = vi
      .spyOn(hookRunnerGlobal, "getGlobalHookRunner")
      .mockReturnValue(hookRunner as never);

    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildTestCtx({
        Surface: "slack",
        From: "channel:C123",
        AccountId: "acc-1",
      }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        deliver: async () => undefined,
      },
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(runMessageSending).toHaveBeenCalledTimes(1);
    expect(runMessageSending.mock.calls[0]?.[1]).toMatchObject({
      channelId: "slack",
      accountId: "acc-1",
      conversationId: "channel:C123",
    });
    hookSpy.mockRestore();
  });
});
