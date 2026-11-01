import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { setReplyPayloadMetadata } from "./reply-payload.js";
import { expectedNoQueuedReplyResult } from "./reply/dispatch-result-expectations.test-support.js";
import { buildTestCtx } from "./reply/test-ctx.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

type DispatchReplyFromConfigFn =
  typeof import("./reply/dispatch-from-config.js").dispatchReplyFromConfig;
type DispatchReplyFromConfigParams = Parameters<DispatchReplyFromConfigFn>[0];

const hoisted = vi.hoisted(() => ({
  dispatchReplyFromConfigMock: vi.fn<DispatchReplyFromConfigFn>(),
}));

vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: (...args: Parameters<DispatchReplyFromConfigFn>) =>
    hoisted.dispatchReplyFromConfigMock(...args),
}));

const { dispatchInboundMessageWithBufferedDispatcher } = await import("./dispatch.js");

type Delivery = { kind: "tool" | "block" | "final"; text: string | undefined };

const finals = (...texts: string[]): Delivery[] => texts.map((text) => ({ kind: "final", text }));

function sendFinal(params: DispatchReplyFromConfigParams, text: string) {
  params.dispatcher.sendFinalReply({ text });
  return queuedFinalResult();
}

function finalReply(
  text?: string,
  wait?: () => Promise<unknown>,
  started?: () => void,
): DispatchReplyFromConfigFn {
  return async (params) => {
    started?.();
    if (wait) {
      await wait();
    }
    return text === undefined ? expectedNoQueuedReplyResult() : sendFinal(params, text);
  };
}

function mockReplies(replies: Record<string, DispatchReplyFromConfigFn>) {
  hoisted.dispatchReplyFromConfigMock.mockImplementation((params) => {
    const reply = replies[params.ctx.MessageSid ?? ""];
    if (!reply) {
      throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
    }
    return reply(params);
  });
}

function pause<T = void>() {
  const started = createDeferred();
  const release = createDeferred<T>();
  return {
    started: started.promise,
    release: release.resolve,
    wait: () => {
      started.resolve();
      return release.promise;
    },
  };
}

function queuedFinalResult() {
  return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
}

function settledFinalResult() {
  const counts = (delivered: number) => ({
    delivered,
    deliveredNotVisible: 0,
    cancelled: 0,
    failedBeforeSend: 0,
    failedAfterSend: 0,
  });
  return {
    ...queuedFinalResult(),
    settledReceipt: {
      counts: { tool: counts(0), block: counts(0), final: counts(1) },
      anyVisibleDelivered: true,
    },
  };
}

function buildForegroundCtx(
  messageId: string,
  overrides: Partial<MsgContext> = {},
): FinalizedMsgContext {
  return buildTestCtx({
    MessageSid: messageId,
    SessionKey: "agent:main:whatsapp:direct:+1000",
    OriginatingChannel: "whatsapp",
    OriginatingTo: "whatsapp:+1000",
    ...overrides,
  });
}

function dispatch(
  message: string | FinalizedMsgContext,
  deliveries: Delivery[],
  dispatcherOptions: Partial<
    Parameters<typeof dispatchInboundMessageWithBufferedDispatcher>[0]["dispatcherOptions"]
  > = {},
) {
  return dispatchInboundMessageWithBufferedDispatcher({
    ctx: typeof message === "string" ? buildForegroundCtx(message) : message,
    cfg: {},
    dispatcherOptions: {
      ...dispatcherOptions,
      deliver:
        dispatcherOptions.deliver ??
        (async (payload: ReplyPayload, info: { kind: Delivery["kind"] }) => {
          deliveries.push({ kind: info.kind, text: payload.text });
        }),
    },
  });
}

describe("foreground reply delivery order", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    hoisted.dispatchReplyFromConfigMock.mockReset();
  });

  afterEach(resetGlobalHookRunner);

  it("retains a waiting successor so a third foreground final cannot overtake", async () => {
    const deliveries: Delivery[] = [];
    const older = pause<ReplyPayload | null>();
    const waiting = pause();
    const newestStarted = createDeferred();

    mockReplies({
      "old-message": finalReply("old final"),
      "waiting-message": finalReply(undefined, waiting.wait),
      "new-message": finalReply("new final", undefined, newestStarted.resolve),
    });

    const olderDispatch = dispatch("old-message", deliveries, {
      beforeDeliver: older.wait,
    });
    await older.started;

    const waitingSuccessorDispatch = dispatch("waiting-message", deliveries);
    await waiting.started;
    const newestDispatch = dispatch("new-message", deliveries);
    await newestStarted.promise;

    older.release({ text: "old final" });
    await olderDispatch;
    expect(deliveries).toEqual(finals("old final"));

    waiting.release();
    await Promise.all([waitingSuccessorDispatch, newestDispatch]);

    expect(deliveries).toEqual(finals("old final", "new final"));
  });

  it("does not charge predecessor waiting against the configured beforeDeliver budget", async () => {
    vi.useFakeTimers();
    try {
      const deliveries: Delivery[] = [];
      const older = pause<ReplyPayload | null>();
      const hookStarted = createDeferred();
      hoisted.dispatchReplyFromConfigMock.mockImplementation(async (params) =>
        sendFinal(params, `${params.ctx.MessageSid} final`),
      );

      const olderDispatch = dispatch("older", deliveries, {
        beforeDeliver: older.wait,
        beforeDeliverOptions: { timeoutMs: 40_000 },
      });
      await older.started;
      const newerDispatch = dispatch("newer", deliveries, {
        beforeDeliver: async (payload) => {
          hookStarted.resolve();
          await new Promise((resolve) => {
            setTimeout(resolve, 16_000);
          });
          return payload;
        },
        beforeDeliverOptions: { timeoutMs: 20_000 },
      });

      await vi.advanceTimersByTimeAsync(20_000);
      expect(deliveries).toEqual([]);
      older.release({ text: "older final" });
      await expect(olderDispatch).resolves.toEqual(settledFinalResult());
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(16_000);

      await expect(newerDispatch).resolves.toEqual(settledFinalResult());
      expect(deliveries).toEqual(finals("older final", "newer final"));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fence an older final behind a newer inbound waiting for its delivery", async () => {
    const deliveries: Delivery[] = [];
    const older = pause();
    const newerStarted = createDeferred();
    const olderDelivered = createDeferred();

    mockReplies({
      "old-message": finalReply("old final", older.wait),
      // Same-session follow-up admission waits for the owning final delivery.
      "new-message": finalReply(undefined, () => olderDelivered.promise, newerStarted.resolve),
    });

    const olderDispatch = dispatch("old-message", deliveries, {
      deliver: async (payload, info) => {
        deliveries.push({ kind: info.kind, text: payload.text });
        olderDelivered.resolve();
      },
    });
    await older.started;

    const newerDispatch = dispatch("new-message", deliveries);
    await newerStarted.promise;
    older.release();

    await expect(olderDispatch).resolves.toEqual(settledFinalResult());
    const newerResult = await newerDispatch;
    expect(newerResult).toMatchObject({
      ...expectedNoQueuedReplyResult(),
      settledReceipt: { anyVisibleDelivered: false },
    });
    expect(deliveries).toEqual(finals("old final"));
  });

  it.each(["onSettled", "onFreshSettledDelivery"] as const)(
    "orders %s delivery behind an earlier foreground final",
    async (settledHook) => {
      const deliveries: Delivery[] = [];
      const older = pause<ReplyPayload | null>();
      const newerStarted = createDeferred();

      mockReplies({
        "old-message": finalReply("old final"),
        "new-message": finalReply(undefined, undefined, newerStarted.resolve),
      });

      const olderDispatch = dispatch("old-message", deliveries, {
        beforeDeliver: older.wait,
      });
      await older.started;
      const newerDispatch = dispatch("new-message", deliveries, {
        [settledHook]: () => {
          deliveries.push({ kind: "final", text: "new settled final" });
          return { visibleReplySent: true };
        },
      });
      await newerStarted.promise;

      older.release({ text: "old final" });
      await Promise.all([olderDispatch, newerDispatch]);

      expect(deliveries).toEqual(finals("old final", "new settled final"));
    },
  );

  it("releases a same-target successor when an earlier dispatch fails", async () => {
    const deliveries: Delivery[] = [];
    const older = pause();
    const newerStarted = createDeferred();
    const error = new Error("resolver failed");

    hoisted.dispatchReplyFromConfigMock.mockImplementation(async (params) => {
      if (params.ctx.MessageSid === "older") {
        await older.wait();
        throw error;
      }
      newerStarted.resolve();
      return sendFinal(params, "newer final");
    });

    const olderDispatch = dispatch("older", deliveries);
    await older.started;
    const newerDispatch = dispatch("newer", deliveries);
    await newerStarted.promise;
    expect(deliveries).toEqual([]);

    older.release();
    await expect(olderDispatch).rejects.toBe(error);
    await expect(newerDispatch).resolves.toEqual(settledFinalResult());
    expect(deliveries).toEqual(finals("newer final"));
  });

  it("keeps concurrent foreground finals isolated for different targets sharing a session", async () => {
    const deliveries: Delivery[] = [];
    const first = pause();

    mockReplies({
      "first-chat": finalReply("first chat final", first.wait),
      "second-chat": finalReply("second chat final"),
    });

    const sharedSessionKey = "agent:main:main";
    const dispatchTo = (messageId: string, target: string) =>
      dispatch(
        buildForegroundCtx(messageId, {
          SessionKey: sharedSessionKey,
          From: target,
          OriginatingTo: target,
        }),
        deliveries,
      );
    const firstDispatch = dispatchTo("first-chat", "whatsapp:+1000");
    await first.started;

    const secondDispatch = dispatchTo("second-chat", "whatsapp:+3000");
    await expect(secondDispatch).resolves.toEqual(settledFinalResult());

    first.release();
    await expect(firstDispatch).resolves.toEqual(settledFinalResult());
    expect(deliveries).toEqual(finals("second chat final", "first chat final"));
  });

  it.each(["status command", "queue admission notice", "queued"] as const)(
    "delivers %s immediately while later ordinary output retains the active turn's fence",
    async (noticeKind) => {
      const deliveries: Delivery[] = [];
      const older = pause();
      const newerStarted = createDeferred();
      const beforeDeliver = vi.fn(async (payload: ReplyPayload) => payload);
      const onSettled = vi.fn();
      const onFreshSettledDelivery = vi.fn();
      const notice = "Runtime notice";
      const pending: Promise<unknown>[] = [];
      mockReplies({
        "old-message": finalReply("old final", older.wait),
        "notice-message": async (params) => {
          const payload = { text: notice, isStatusNotice: true };
          params.dispatcher.sendFinalReply(
            noticeKind !== "status command"
              ? setReplyPayloadMetadata(payload, {
                  queueAdmissionNotice: noticeKind === "queued" ? "queued" : true,
                })
              : payload,
          );
          return queuedFinalResult();
        },
        "new-message": async (params) => {
          newerStarted.resolve();
          // A generic status flag is not an admission acknowledgment.
          params.dispatcher.sendFinalReply({ text: "new status", isStatusNotice: true });
          return queuedFinalResult();
        },
      });
      try {
        const olderDispatch = dispatch("old-message", deliveries);
        pending.push(olderDispatch);
        await older.started;
        const noticeDispatch = dispatch(
          buildForegroundCtx(
            "notice-message",
            noticeKind === "status command"
              ? {
                  CommandTurn: {
                    kind: "text-slash",
                    source: "text",
                    authorized: true,
                    commandName: "status",
                    body: "/status",
                  },
                }
              : {},
          ),
          deliveries,
          { beforeDeliver, onSettled, onFreshSettledDelivery },
        );
        pending.push(noticeDispatch);
        await expect(noticeDispatch).resolves.toEqual(settledFinalResult());
        expect(beforeDeliver).toHaveBeenCalledOnce();
        expect(onSettled).toHaveBeenCalledOnce();
        expect(onFreshSettledDelivery).toHaveBeenCalledOnce();
        const newerDispatch = dispatch("new-message", deliveries);
        pending.push(newerDispatch);
        await newerStarted.promise;
        expect(deliveries).toEqual(finals(notice));
        older.release();
        await Promise.all([olderDispatch, newerDispatch]);
        expect(deliveries).toEqual(finals(notice, "old final", "new status"));
      } finally {
        older.release();
        await Promise.allSettled(pending);
      }
    },
  );
});
