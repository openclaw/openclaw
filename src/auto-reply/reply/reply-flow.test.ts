import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  composeReplyDispatchBeforeDeliver,
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  waitForReplyDispatcherIdle,
} from "./reply-dispatcher.js";

type DeliverPayload = Parameters<Parameters<typeof createReplyDispatcher>[0]["deliver"]>[0];
type DeliverMock = { mock: { calls: unknown[][] } };

function deliveredText(deliver: DeliverMock, index = 0) {
  const payload = deliver.mock.calls[index]?.[0] as DeliverPayload | undefined;
  return payload?.text;
}

afterEach(() => {
  vi.useRealTimers();
});

function delayedSuffix(suffix: string, timeoutMs: number) {
  return async (payload: DeliverPayload) => {
    await new Promise((resolve) => {
      setTimeout(resolve, timeoutMs);
    });
    return { ...payload, text: `${payload.text}:${suffix}` };
  };
}

function recordDispatch(
  options: Omit<Parameters<typeof createReplyDispatcher>[0], "deliver" | "onError">,
) {
  const delivered: string[] = [];
  const errors: string[] = [];
  const dispatcher = createReplyDispatcher({
    ...options,
    deliver: async (payload) => {
      delivered.push(payload.text ?? "");
    },
    onError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });
  return { dispatcher, delivered, errors };
}

describe("createReplyDispatcher", () => {
  it("drops empty payloads and forwards prepared text literally", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    expect(dispatcher.sendFinalReply({})).toBe(false);
    expect(dispatcher.sendFinalReply({ text: " " })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(true);
    expect(dispatcher.sendFinalReply({ text: `${SILENT_REPLY_TOKEN} -- nope` })).toBe(true);
    expect(dispatcher.sendFinalReply({ text: `interject.${SILENT_REPLY_TOKEN}` })).toBe(true);

    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliveredText(deliver)).toBe(SILENT_REPLY_TOKEN);
    expect(deliveredText(deliver, 1)).toBe(`${SILENT_REPLY_TOKEN} -- nope`);
    expect(deliveredText(deliver, 2)).toBe(`interject.${SILENT_REPLY_TOKEN}`);
  });

  it("keeps recorded silence off transport without recording delivery", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      silentReplyContext: {
        sessionKey: "agent:main:telegram:direct:123",
        surface: "telegram",
      },
    });

    expect(
      dispatcher.sendFinalReply(
        setReplyPayloadMetadata({ text: SILENT_REPLY_TOKEN }, { silentReply: true }),
      ),
    ).toBe(false);

    const receipt = await dispatcher.waitForIdle();
    expect(deliver).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      anyVisibleDelivered: false,
      counts: { final: { delivered: 0 } },
    });
  });

  it("strips heartbeat tokens and applies responsePrefix", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onHeartbeatStrip = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver,
      responsePrefix: "PFX",
      onHeartbeatStrip,
    });

    expect(dispatcher.sendFinalReply({ text: HEARTBEAT_TOKEN })).toBe(false);
    expect(dispatcher.sendToolResult({ text: `${HEARTBEAT_TOKEN} hello` })).toBe(true);
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliveredText(deliver)).toBe("PFX hello");
    expect(onHeartbeatStrip).toHaveBeenCalledTimes(2);
  });

  it("preserves ordering across tool, block, and final replies", async () => {
    const delivered: string[] = [];
    const deliver = vi.fn(async (_payload, info) => {
      delivered.push(info.kind);
      if (info.kind === "tool") {
        await Promise.resolve();
      }
    });
    const dispatcher = createReplyDispatcher({ deliver });

    dispatcher.sendToolResult({ text: "tool" });
    dispatcher.sendBlockReply({ text: "block" });
    dispatcher.sendFinalReply({ text: "final" });

    await dispatcher.waitForIdle();
    expect(delivered).toEqual(["tool", "block", "final"]);
  });

  it("waits for asynchronous delivery error cleanup before becoming idle", async () => {
    const cleanup = createDeferred();
    const order: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw new Error("delivery failed");
      },
      onError: async () => {
        order.push("cleanup-start");
        await cleanup.promise;
        order.push("cleanup-end");
      },
    });

    dispatcher.sendFinalReply({ text: "final" });
    const idle = dispatcher.waitForIdle().then(() => {
      order.push("idle");
    });
    await vi.waitFor(() => expect(order).toEqual(["cleanup-start"]));

    cleanup.resolve();
    await idle;
    expect(order).toEqual(["cleanup-start", "cleanup-end", "idle"]);
  });

  it("releases the same dispatcher after a beforeDeliver timeout", async () => {
    vi.useFakeTimers();
    const hookStarted = createDeferred();
    let hookCalls = 0;
    const { dispatcher, delivered, errors } = recordDispatch({
      beforeDeliver: (payload) => {
        hookCalls += 1;
        if (hookCalls === 1) {
          hookStarted.resolve();
          return new Promise<never>(() => {});
        }
        return payload;
      },
    });

    dispatcher.sendFinalReply({ text: "stuck final" });
    dispatcher.sendFinalReply({ text: "follow-up final" });
    dispatcher.markComplete();
    await hookStarted.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["follow-up final"]);
    expect(errors).toEqual(["beforeDeliver timed out after 15000ms"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects non-positive and non-finite beforeDeliver budgets", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createReplyDispatcher({
          deliver: async () => {},
          beforeDeliver: (payload) => payload,
          beforeDeliverOptions: { timeoutMs },
        }),
      ).toThrow("beforeDeliver timeoutMs must be a positive finite number");

      const dispatcher = createReplyDispatcher({ deliver: async () => {} });
      expect(() => dispatcher.appendBeforeDeliver?.((payload) => payload, { timeoutMs })).toThrow(
        "beforeDeliver timeoutMs must be a positive finite number",
      );
    }
  });

  it("honors owner-declared budgets for constructor and appended callbacks", async () => {
    vi.useFakeTimers();
    const { dispatcher, delivered, errors } = recordDispatch({
      beforeDeliver: delayedSuffix("constructor", 16_000),
      beforeDeliverOptions: { timeoutMs: 20_000 },
    });
    dispatcher.appendBeforeDeliver?.(delayedSuffix("appended", 16_000), { timeoutMs: 20_000 });

    dispatcher.sendFinalReply({ text: "final" });
    dispatcher.markComplete();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["final:constructor:appended"]);
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not turn a composed stage budget into a whole-chain deadline", async () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const beforeDeliver = composeReplyDispatchBeforeDeliver(
      {
        hook: delayedSuffix("owner", 16_000),
        options: { timeoutMs: 20_000 },
      },
      delayedSuffix("plugin", 10_000),
    );
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      beforeDeliver,
      beforeDeliverOptions: { timeoutMs: 20_000 },
    });

    dispatcher.sendFinalReply({ text: "final" });
    dispatcher.markComplete();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000);
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["final:owner:plugin"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies a hook appended after enqueue before the chain starts", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    dispatcher.sendFinalReply({ text: "queued" });
    dispatcher.appendBeforeDeliver?.((payload) => ({ ...payload, text: "appended" }));
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliveredText(deliver)).toBe("appended");
  });

  it.each(["onIdle", "onSettled"] as const)(
    "releases deferred delivery finalization from %s before sealing",
    async (settleHook) => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const { promise: finalization, resolve: finalize } = createDeferred<{
        visibleReplySent: true;
      }>();
      const settle = () => finalize({ visibleReplySent: true });
      const { dispatcher } = createReplyDispatcherWithTyping({
        deliver: async () => ({ visibleReplySent: false, finalization }),
        ...(settleHook === "onIdle" ? { onIdle: settle } : { onSettled: settle }),
      });

      dispatcher.sendFinalReply({ text: "final" });
      dispatcher.markComplete();
      const receipt = dispatcher.waitForIdle();
      const bounded = Promise.race([
        receipt,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 100);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(100);

      await expect(bounded).resolves.toMatchObject({
        anyVisibleDelivered: true,
        counts: { final: { delivered: 1, deliveredNotVisible: 0 } },
      });
    },
  );

  it("resolves an owner-declared follow-up admission barrier policy from queued deliveries", async () => {
    vi.useFakeTimers();
    const dispatcher = createReplyDispatcher({
      deliver: async () => {},
      resolveFollowupAdmissionBarrierTimeoutPolicy: ({ queuedCounts, humanDelayBudgetMs }) => ({
        maxTimeoutMs:
          Object.values(queuedCounts).reduce((sum, count) => sum + count, 0) * 35 * 60_000 +
          humanDelayBudgetMs,
        shouldExtend: () => true,
      }),
      humanDelay: { mode: "custom", minMs: 10_000, maxMs: 20_000 },
    });
    dispatcher.sendToolResult({ text: "tool" });
    dispatcher.sendBlockReply({ text: "block one" });
    dispatcher.sendBlockReply({ text: "block two" });
    dispatcher.sendFinalReply({ text: "final" });
    dispatcher.markComplete();

    const policy = dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.();
    expect(policy?.maxTimeoutMs).toBe(140 * 60_000 + 20_000);
    expect(policy?.shouldExtend()).toBe(true);
    await vi.runAllTimersAsync();
    await dispatcher.waitForIdle();
  });

  it("reports each queued delivery settlement", async () => {
    const onDeliverySettled = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: vi.fn().mockRejectedValueOnce(new Error("send failed")).mockResolvedValue(undefined),
      onDeliverySettled,
    });
    dispatcher.sendToolResult({ text: "tool" });
    dispatcher.sendFinalReply({ text: "final" });
    dispatcher.markComplete();

    await dispatcher.waitForIdle();
    expect(onDeliverySettled).toHaveBeenCalledTimes(2);
    expect(onDeliverySettled).toHaveBeenNthCalledWith(1, { kind: "tool" });
    expect(onDeliverySettled).toHaveBeenNthCalledWith(2, { kind: "final" });
  });

  it.each([
    [{ mode: "natural" }, 799],
    [{ mode: "custom", minMs: 1200, maxMs: 400 }, 1199],
  ] as const)(
    "delays later blocks using %j, including clamped custom bounds",
    async (humanDelay, beforeMs) => {
      vi.useFakeTimers();
      const deliver = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createReplyDispatcher({ deliver, humanDelay });
      dispatcher.sendBlockReply({ text: "first" });
      await Promise.resolve();
      expect(deliver).toHaveBeenCalledTimes(1);
      dispatcher.sendBlockReply({ text: "second" });
      await Promise.resolve();
      expect(deliver).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(beforeMs);
      expect(deliver).toHaveBeenCalledTimes(1);
      if (humanDelay.mode === "natural") {
        await vi.runAllTimersAsync();
      } else {
        await vi.advanceTimersByTimeAsync(1);
      }
      await dispatcher.waitForIdle();
      expect(deliver).toHaveBeenCalledTimes(2);
    },
  );
});

describe("waitForReplyDispatcherIdle", () => {
  it("returns when the abort signal fires before the dispatcher becomes idle", async () => {
    const controller = new AbortController();
    const waitForIdle = vi.fn(
      () =>
        new Promise<void>(() => {
          // Keep the dispatcher busy until the abort path wins.
        }),
    );

    let settled = false;
    const waitPromise = waitForReplyDispatcherIdle({ waitForIdle }, controller.signal).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    controller.abort();
    await waitPromise;

    expect(settled).toBe(true);
    expect(waitForIdle).toHaveBeenCalledTimes(1);
  });
});
