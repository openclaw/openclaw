import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as internalHooks from "../hooks/internal-hooks.js";
import * as hookRunnerGlobal from "../plugins/hook-runner-global.js";
import {
  dispatchInboundMessage,
  dispatchInboundMessageWithDispatcher,
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
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("emits message:sent hooks for successful dispatcher deliveries", async () => {
    const runMessageSent = vi.fn(async () => {});
    const triggerInternalHookSpy = vi
      .spyOn(internalHooks, "triggerInternalHook")
      .mockResolvedValue(undefined);
    vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue({
      hasHooks: (name: string) => name === "message_sent",
      runMessageSent,
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    await dispatchInboundMessageWithDispatcher({
      ctx: buildTestCtx({
        SessionKey: "agent:main:main",
        Surface: "discord",
        Provider: "discord",
        To: "channel:C1",
        AccountId: "work",
      }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        deliver: async () => {},
      },
      replyResolver: async () => ({ text: "hello hook" }),
    });

    expect(runMessageSent).toHaveBeenCalledTimes(1);
    expect(runMessageSent).toHaveBeenCalledWith(
      {
        to: "channel:C1",
        content: "hello hook",
        success: true,
      },
      {
        channelId: "discord",
        accountId: "work",
        conversationId: "channel:C1",
      },
    );
    const sentCalls = triggerInternalHookSpy.mock.calls.filter(
      (call) =>
        (call[0] as internalHooks.InternalHookEvent | undefined)?.type === "message" &&
        (call[0] as internalHooks.InternalHookEvent | undefined)?.action === "sent",
    );
    expect(sentCalls).toHaveLength(1);
    const hookEvent = sentCalls[0]?.[0] as internalHooks.InternalHookEvent | undefined;
    expect(hookEvent?.type).toBe("message");
    expect(hookEvent?.action).toBe("sent");
    expect(hookEvent?.sessionKey).toBe("agent:main:main");
    expect(hookEvent?.context).toMatchObject({
      to: "channel:C1",
      content: "hello hook",
      success: true,
      channelId: "discord",
      accountId: "work",
      conversationId: "channel:C1",
    });
  });

  it("emits message:sent hooks with success=false when delivery fails", async () => {
    const runMessageSent = vi.fn(async () => {});
    const deliver = vi.fn(async () => {
      throw new Error("send failed");
    });
    const triggerInternalHookSpy = vi
      .spyOn(internalHooks, "triggerInternalHook")
      .mockResolvedValue(undefined);
    vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue({
      hasHooks: (name: string) => name === "message_sent",
      runMessageSent,
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    await dispatchInboundMessageWithDispatcher({
      ctx: buildTestCtx({
        SessionKey: "agent:main:main",
        Surface: "slack",
        Provider: "slack",
        To: "channel:C2",
      }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        deliver,
      },
      replyResolver: async () => ({ text: "will fail" }),
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(runMessageSent).toHaveBeenCalledTimes(1);
    expect(runMessageSent).toHaveBeenCalledWith(
      {
        to: "channel:C2",
        content: "will fail",
        success: false,
        error: "send failed",
      },
      {
        channelId: "slack",
        accountId: undefined,
        conversationId: "channel:C2",
      },
    );
    const sentCalls = triggerInternalHookSpy.mock.calls.filter(
      (call) =>
        (call[0] as internalHooks.InternalHookEvent | undefined)?.type === "message" &&
        (call[0] as internalHooks.InternalHookEvent | undefined)?.action === "sent",
    );
    expect(sentCalls).toHaveLength(1);
    const hookEvent = sentCalls[0]?.[0] as internalHooks.InternalHookEvent | undefined;
    expect(hookEvent?.context).toMatchObject({
      to: "channel:C2",
      content: "will fail",
      success: false,
      error: "send failed",
      channelId: "slack",
      conversationId: "channel:C2",
    });
  });
});
