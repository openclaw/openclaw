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
function dispatchFixture(options: Partial<Parameters<typeof createReplyDispatcher>[0]> = {}) {
  const deliver = vi.fn(options.deliver ?? (async () => {}));
  return { deliver, dispatcher: createReplyDispatcher({ ...options, deliver }) };
}

function deliveredTexts(deliver: ReturnType<typeof dispatchFixture>["deliver"]) {
  return deliver.mock.calls.map(([payload]) => payload.text);
}

afterEach(() => vi.useRealTimers());

function delayedSuffix(suffix: string, timeoutMs: number) {
  return async (payload: DeliverPayload) => {
    await new Promise((resolve) => {
      setTimeout(resolve, timeoutMs);
    });
    return { ...payload, text: `${payload.text}:${suffix}` };
  };
}

describe("createReplyDispatcher", () => {
  it("drops empty payloads and forwards prepared text literally", async () => {
    const { deliver, dispatcher } = dispatchFixture();

    expect(dispatcher.sendFinalReply({})).toBe(false);
    expect(dispatcher.sendFinalReply({ text: " " })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(true);
    expect(dispatcher.sendFinalReply({ text: `${SILENT_REPLY_TOKEN} -- nope` })).toBe(true);
    expect(dispatcher.sendFinalReply({ text: `interject.${SILENT_REPLY_TOKEN}` })).toBe(true);

    await dispatcher.waitForIdle();
    expect(deliveredTexts(deliver)).toEqual([
      SILENT_REPLY_TOKEN,
      `${SILENT_REPLY_TOKEN} -- nope`,
      `interject.${SILENT_REPLY_TOKEN}`,
    ]);
  });

  it("keeps recorded silence off transport without recording delivery", async () => {
    const { deliver, dispatcher } = dispatchFixture();

    const payload = setReplyPayloadMetadata({ text: SILENT_REPLY_TOKEN }, { silentReply: true });
    expect(dispatcher.sendFinalReply(payload)).toBe(false);

    const receipt = await dispatcher.waitForIdle();
    expect(deliver).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      anyVisibleDelivered: false,
      counts: { final: { delivered: 0 } },
    });
  });

  it("strips heartbeat tokens and applies responsePrefix", async () => {
    const onHeartbeatStrip = vi.fn();
    const { deliver, dispatcher } = dispatchFixture({
      responsePrefix: "PFX",
      onHeartbeatStrip,
    });

    expect(dispatcher.sendFinalReply({ text: HEARTBEAT_TOKEN })).toBe(false);
    expect(dispatcher.sendToolResult({ text: `${HEARTBEAT_TOKEN} hello` })).toBe(true);
    await dispatcher.waitForIdle();

    expect(deliveredTexts(deliver)).toEqual(["PFX hello"]);
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
    const onError = vi.fn<(error: unknown) => void>();
    const { dispatcher, deliver } = dispatchFixture({
      onError,
      beforeDeliver: (payload) => {
        if (++hookCalls === 1) {
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

    expect(deliveredTexts(deliver)).toEqual(["follow-up final"]);
    expect(
      onError.mock.calls.map(([error]) => (error instanceof Error ? error.message : String(error))),
    ).toEqual(["beforeDeliver timed out after 15000ms"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects non-positive and non-finite beforeDeliver budgets", () => {
    const error = "beforeDeliver timeoutMs must be a positive finite number";
    const { dispatcher } = dispatchFixture();
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        dispatchFixture({
          beforeDeliver: (payload) => payload,
          beforeDeliverOptions: { timeoutMs },
        }),
      ).toThrow(error);
      expect(() => dispatcher.appendBeforeDeliver?.((payload) => payload, { timeoutMs })).toThrow(
        error,
      );
    }
  });

  it.each([
    ["appended", [15_000, 1_000, 15_000], 1_000],
    ["composed", [20_000], 6_000],
  ] as const)(
    "honors per-stage budgets without imposing a whole-chain deadline (%s)",
    async (mode, checkpoints, remainingMs) => {
      vi.useFakeTimers();
      const appended = mode === "appended";
      const onError = vi.fn();
      const first = delayedSuffix("first", 16_000);
      const second = delayedSuffix("second", appended ? 16_000 : 10_000);
      const { dispatcher, deliver } = dispatchFixture({
        beforeDeliver: appended
          ? first
          : composeReplyDispatchBeforeDeliver(
              { hook: first, options: { timeoutMs: 20_000 } },
              second,
            ),
        beforeDeliverOptions: { timeoutMs: 20_000 },
        ...(appended ? { onError } : {}),
      });
      if (appended) {
        dispatcher.appendBeforeDeliver?.(second, { timeoutMs: 20_000 });
      }
      dispatcher.sendFinalReply({ text: "final" });
      dispatcher.markComplete();
      for (const elapsedMs of checkpoints) {
        await vi.advanceTimersByTimeAsync(elapsedMs);
        expect(deliver).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(remainingMs);
      await dispatcher.waitForIdle();
      expect(deliveredTexts(deliver)).toEqual(["final:first:second"]);
      if (appended) {
        expect(onError).not.toHaveBeenCalled();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("applies a hook appended after enqueue before the chain starts", async () => {
    const { deliver, dispatcher } = dispatchFixture();

    dispatcher.sendFinalReply({ text: "queued" });
    dispatcher.appendBeforeDeliver?.((payload) => ({ ...payload, text: "appended" }));
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliveredTexts(deliver)).toEqual(["appended"]);
  });

  it.each(["onIdle", "onSettled"] as const)(
    "releases deferred delivery finalization from %s before sealing",
    async (settleHook) => {
      const { promise: finalization, resolve: finalize } = createDeferred<{
        visibleReplySent: true;
      }>();
      const { dispatcher } = createReplyDispatcherWithTyping({
        deliver: async () => ({ visibleReplySent: false, finalization }),
        [settleHook]: () => finalize({ visibleReplySent: true }),
      });

      dispatcher.sendFinalReply({ text: "final" });
      dispatcher.markComplete();
      await expect(dispatcher.waitForIdle()).resolves.toMatchObject({
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
    expect(onDeliverySettled.mock.calls).toEqual([[{ kind: "tool" }], [{ kind: "final" }]]);
  });

  it.each([
    [{ mode: "natural" }, 799],
    [{ mode: "custom", minMs: 1200, maxMs: 400 }, 1199],
  ] as const)(
    "delays later blocks using %j, including clamped custom bounds",
    async (humanDelay, beforeMs) => {
      vi.useFakeTimers();
      const { deliver, dispatcher } = dispatchFixture({ humanDelay });
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

it("returns when the abort signal fires before the dispatcher becomes idle", async () => {
  const controller = new AbortController();
  const waitForIdle = vi.fn(() => new Promise<void>(() => {}));

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
