// Tests before-deliver hook ordering and payload mutation behavior.
import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { createReplyDispatcher, createReplyDispatcherWithTyping } from "./reply-dispatcher.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingController, VISIBLE_DELIVERY_TYPING_START_TIMEOUT_MS } from "./typing.js";

describe("beforeDeliver in reply dispatcher", () => {
  it("cancels delivery before queueing when transformReplyPayload returns null", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      transformReplyPayload: (payload: ReplyPayload) => {
        if (payload.text?.includes("blocked")) {
          return null;
        }
        return payload;
      },
    });

    expect(dispatcher.sendFinalReply({ text: "blocked reply" })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: "safe reply" })).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
  });

  it("cancels delivery when beforeDeliver returns null", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      beforeDeliver: async (payload: ReplyPayload) => {
        if (payload.text?.includes("blocked")) {
          return null;
        }
        return payload;
      },
    });

    dispatcher.sendFinalReply({ text: "blocked reply" });
    dispatcher.sendFinalReply({ text: "safe reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 2 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
  });

  it("allows modifying payload in beforeDeliver", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      beforeDeliver: async (payload: ReplyPayload) => {
        if (payload.text?.includes("error")) {
          return { ...payload, text: "replaced" };
        }
        return payload;
      },
    });

    dispatcher.sendFinalReply({ text: "some error occurred" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["replaced"]);
  });

  it("delivers normally without beforeDeliver", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });

    dispatcher.sendFinalReply({ text: "plain reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["plain reply"]);
  });

  it("starts real visible-delivery typing once after accepted delivery", async () => {
    const order: string[] = [];
    const onReplyStart = vi.fn(async () => {
      order.push("typing");
    });

    const { dispatcher, markRunComplete, replyOptions } = createReplyDispatcherWithTyping({
      typingStartPolicy: "visible_delivery",
      onReplyStart,
      deliver: async (payload, info) => {
        await info.startVisibleDeliveryTyping?.();
        order.push(`deliver:${payload.text ?? ""}`);
      },
      transformReplyPayload: () => ({ text: "normalized" }),
      beforeDeliver: async (payload: ReplyPayload) => {
        order.push(`before:${payload.text ?? ""}`);
        return { ...payload, text: "approved" };
      },
    });
    const typing = createTypingController({
      onReplyStart: replyOptions.onReplyStart,
    });
    replyOptions.onTypingController?.(typing);
    markRunComplete();

    dispatcher.sendFinalReply({ text: "raw" });
    dispatcher.sendFinalReply({ text: "raw again" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(order).toEqual([
      "before:normalized",
      "typing",
      "deliver:approved",
      "before:normalized",
      "deliver:approved",
    ]);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("awaits fallback visible-delivery typing before delivery", async () => {
    const delivered: string[] = [];
    const order: string[] = [];
    let resolveTyping!: () => void;
    const typingStarted = new Promise<void>((resolve) => {
      resolveTyping = resolve;
    });
    const onReplyStart = vi.fn(async () => {
      order.push("typing:start");
      await typingStarted;
      order.push("typing:done");
    });

    const { dispatcher } = createReplyDispatcherWithTyping({
      typingStartPolicy: "visible_delivery",
      onReplyStart,
      deliver: async (payload, info) => {
        await info.startVisibleDeliveryTyping?.();
        order.push("deliver");
        delivered.push(payload.text ?? "");
      },
    });

    dispatcher.sendFinalReply({ text: "visible" });
    dispatcher.markComplete();
    const idle = dispatcher.waitForIdle();
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["typing:start"]);
    expect(delivered).toEqual([]);

    resolveTyping();
    await idle;

    expect(order).toEqual(["typing:start", "typing:done", "deliver"]);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(["visible"]);
  });

  it.each([
    { name: "typing controller", installController: true },
    { name: "fallback lifecycle callback", installController: false },
  ] as const)(
    "continues delivery when $name visible-delivery typing stalls past the bounded wait",
    async ({ installController }) => {
      vi.useFakeTimers();
      try {
        const delivered: string[] = [];
        const startTyping = vi.fn(() => new Promise<void>(() => {}));

        const { dispatcher, replyOptions } = createReplyDispatcherWithTyping({
          typingStartPolicy: "visible_delivery",
          ...(installController ? {} : { onReplyStart: startTyping }),
          deliver: async (payload, info) => {
            await info.startVisibleDeliveryTyping?.();
            delivered.push(payload.text ?? "");
          },
        });
        if (installController) {
          replyOptions.onTypingController?.(
            createMockTypingController({
              startTypingForVisibleDelivery: startTyping,
            }),
          );
        }

        dispatcher.sendFinalReply({ text: "visible" });
        dispatcher.markComplete();
        const idle = dispatcher.waitForIdle();
        await Promise.resolve();
        await Promise.resolve();

        expect(startTyping).toHaveBeenCalledTimes(1);
        expect(delivered).toEqual([]);

        await vi.advanceTimersByTimeAsync(VISIBLE_DELIVERY_TYPING_START_TIMEOUT_MS);
        await idle;

        expect(delivered).toEqual(["visible"]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    {
      name: "beforeDeliver cancels",
      options: {
        beforeDeliver: async () => null,
      },
      payload: { text: "blocked" },
    },
    {
      name: "suppressTyping is hard never",
      options: {
        suppressTyping: true,
      },
      payload: { text: "visible" },
    },
    {
      name: "delivery owner leaves the hook silent",
      options: {},
      payload: { text: "dropped" },
      skipHook: true,
    },
  ] as const)("does not start visible-delivery typing when $name", async (testCase) => {
    const typing = createMockTypingController();

    const { dispatcher, replyOptions } = createReplyDispatcherWithTyping({
      ...testCase.options,
      typingStartPolicy: "visible_delivery",
      deliver: async (_payload, info) => {
        if (!("skipHook" in testCase) || testCase.skipHook !== true) {
          await info.startVisibleDeliveryTyping?.();
        }
      },
    });
    replyOptions.onTypingController?.(typing);

    dispatcher.sendFinalReply(testCase.payload);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(typing.startTypingForVisibleDelivery).not.toHaveBeenCalled();
  });
});
