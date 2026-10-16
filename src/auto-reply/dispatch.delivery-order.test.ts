/** Tests foreground reply delivery ordering for buffered inbound dispatch. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { setReplyPayloadMetadata } from "./reply-payload.js";
import { expectedNoQueuedReplyResult } from "./reply/dispatch-result-expectations.test-support.js";
import type { ReplyDispatchBeforeDeliver } from "./reply/reply-dispatcher.js";
import type { ReplyDispatchBeforeDeliverOptions } from "./reply/reply-dispatcher.types.js";
import { buildTestCtx } from "./reply/test-ctx.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

type DispatchReplyFromConfigFn =
  typeof import("./reply/dispatch-from-config.js").dispatchReplyFromConfig;
type DispatchReplyFromConfigParams = Parameters<DispatchReplyFromConfigFn>[0];

const hoisted = vi.hoisted(() => ({
  dispatchReplyFromConfigMock: vi.fn(),
}));

vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: (...args: Parameters<DispatchReplyFromConfigFn>) =>
    hoisted.dispatchReplyFromConfigMock(...args),
}));

const { dispatchInboundMessageWithBufferedDispatcher } = await import("./dispatch.js");

type Delivery = {
  kind: "tool" | "block" | "final";
  text: string | undefined;
};

function queuedFinalResult() {
  return {
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  };
}

function settledFinalResult() {
  return {
    ...queuedFinalResult(),
    settledReceipt: {
      counts: {
        tool: {
          delivered: 0,
          deliveredNotVisible: 0,
          cancelled: 0,
          failedBeforeSend: 0,
          failedAfterSend: 0,
        },
        block: {
          delivered: 0,
          deliveredNotVisible: 0,
          cancelled: 0,
          failedBeforeSend: 0,
          failedAfterSend: 0,
        },
        final: {
          delivered: 1,
          deliveredNotVisible: 0,
          cancelled: 0,
          failedBeforeSend: 0,
          failedAfterSend: 0,
        },
      },
      anyVisibleDelivered: true,
    },
  };
}

function buildForegroundCtx(overrides: Partial<MsgContext> = {}): FinalizedMsgContext {
  return buildTestCtx({
    SessionKey: "agent:main:whatsapp:direct:+1000",
    AccountId: "default",
    From: "whatsapp:+1000",
    To: "whatsapp:bot",
    ChatType: "direct",
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: "whatsapp:+1000",
    ...overrides,
  });
}

function dispatchWithDeliveries(
  ctx: FinalizedMsgContext,
  deliveries: Delivery[],
  dispatcherOptions: {
    beforeDeliver?: ReplyDispatchBeforeDeliver;
    beforeDeliverOptions?: ReplyDispatchBeforeDeliverOptions;
    deliver?: (payload: ReplyPayload, info: { kind: Delivery["kind"] }) => Promise<object | void>;
    onBeforeDeliverCancelled?: (payload: ReplyPayload, info: { kind: Delivery["kind"] }) => void;
    onSettled?: () => object | void | Promise<object | void>;
    onFreshSettledDelivery?: () => object | void | Promise<object | void>;
  } = {},
) {
  return dispatchInboundMessageWithBufferedDispatcher({
    ctx,
    cfg: {} as OpenClawConfig,
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

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("retains a waiting successor so a third foreground final cannot overtake", async () => {
    const deliveries: Delivery[] = [];
    const olderBeforeDeliverStarted = createDeferred();
    const releaseOlderBeforeDeliver = createDeferred<ReplyPayload | null>();
    const waitingSuccessorStarted = createDeferred();
    const newestStarted = createDeferred();
    const releaseWaitingSuccessor = createDeferred();

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "waiting-message") {
          waitingSuccessorStarted.resolve();
          await releaseWaitingSuccessor.promise;
          return {
            queuedFinal: false,
            counts: { tool: 0, block: 0, final: 0 },
          };
        }
        if (params.ctx.MessageSid === "new-message") {
          newestStarted.resolve();
          params.dispatcher.sendFinalReply({ text: "new final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      {
        beforeDeliver: () => {
          olderBeforeDeliverStarted.resolve();
          return releaseOlderBeforeDeliver.promise;
        },
      },
    );
    await olderBeforeDeliverStarted.promise;

    const waitingSuccessorDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "waiting-message" }),
      deliveries,
    );
    await waitingSuccessorStarted.promise;
    const newestDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
    );
    await newestStarted.promise;

    releaseOlderBeforeDeliver.resolve({ text: "old final" });
    await olderDispatch;
    expect(deliveries).toEqual([{ kind: "final", text: "old final" }]);

    releaseWaitingSuccessor.resolve();
    await Promise.all([waitingSuccessorDispatch, newestDispatch]);

    expect(deliveries).toEqual([
      { kind: "final", text: "old final" },
      { kind: "final", text: "new final" },
    ]);
  });

  it("does not charge predecessor waiting against the configured beforeDeliver budget", async () => {
    vi.useFakeTimers();
    try {
      const deliveries: Delivery[] = [];
      const olderHookStarted = createDeferred();
      const releaseOlderHook = createDeferred<ReplyPayload | null>();
      const hookStarted = createDeferred();
      hoisted.dispatchReplyFromConfigMock.mockImplementation(
        async (params: DispatchReplyFromConfigParams) => {
          params.dispatcher.sendFinalReply({ text: `${params.ctx.MessageSid} final` });
          return queuedFinalResult();
        },
      );

      const olderDispatch = dispatchWithDeliveries(
        buildForegroundCtx({ MessageSid: "older" }),
        deliveries,
        {
          beforeDeliver: () => {
            olderHookStarted.resolve();
            return releaseOlderHook.promise;
          },
          beforeDeliverOptions: { timeoutMs: 40_000 },
        },
      );
      await olderHookStarted.promise;
      const newerDispatch = dispatchWithDeliveries(
        buildForegroundCtx({ MessageSid: "newer" }),
        deliveries,
        {
          beforeDeliver: async (payload) => {
            hookStarted.resolve();
            await new Promise((resolve) => {
              setTimeout(resolve, 16_000);
            });
            return payload;
          },
          beforeDeliverOptions: { timeoutMs: 20_000 },
        },
      );

      await vi.advanceTimersByTimeAsync(20_000);
      expect(deliveries).toEqual([]);
      releaseOlderHook.resolve({ text: "older final" });
      await expect(olderDispatch).resolves.toEqual(settledFinalResult());
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(16_000);

      await expect(newerDispatch).resolves.toEqual(settledFinalResult());
      expect(deliveries).toEqual([
        { kind: "final", text: "older final" },
        { kind: "final", text: "newer final" },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fence an older final behind a newer inbound waiting for its delivery", async () => {
    const deliveries: Delivery[] = [];
    const olderStarted = createDeferred();
    const newerStarted = createDeferred();
    const releaseOlderFinal = createDeferred();
    const olderDelivered = createDeferred();

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          olderStarted.resolve();
          await releaseOlderFinal.promise;
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          newerStarted.resolve();
          // Same-session follow-up admission waits for the owning final delivery.
          await olderDelivered.promise;
          return {
            queuedFinal: false,
            counts: { tool: 0, block: 0, final: 0 },
          };
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      {
        deliver: async (payload, info) => {
          deliveries.push({ kind: info.kind, text: payload.text });
          olderDelivered.resolve();
        },
      },
    );
    await olderStarted.promise;

    const newerDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
    );
    await newerStarted.promise;
    releaseOlderFinal.resolve();

    await expect(olderDispatch).resolves.toEqual(settledFinalResult());
    const newerResult = await newerDispatch;
    expect(newerResult).toMatchObject(expectedNoQueuedReplyResult());
    expect(newerResult.settledReceipt?.anyVisibleDelivered).toBe(false);
    expect(deliveries).toEqual([{ kind: "final", text: "old final" }]);
  });

  it.each(["onSettled", "onFreshSettledDelivery"] as const)(
    "orders %s delivery behind an earlier foreground final",
    async (settledHook) => {
      const deliveries: Delivery[] = [];
      const olderBeforeDeliverStarted = createDeferred();
      const releaseOlderBeforeDeliver = createDeferred<ReplyPayload | null>();
      const newerStarted = createDeferred();

      hoisted.dispatchReplyFromConfigMock.mockImplementation(
        async (params: DispatchReplyFromConfigParams) => {
          if (params.ctx.MessageSid === "old-message") {
            params.dispatcher.sendFinalReply({ text: "old final" });
            return queuedFinalResult();
          }
          if (params.ctx.MessageSid === "new-message") {
            newerStarted.resolve();
            return {
              queuedFinal: false,
              counts: { tool: 0, block: 0, final: 0 },
            };
          }
          throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
        },
      );

      const olderDispatch = dispatchWithDeliveries(
        buildForegroundCtx({ MessageSid: "old-message" }),
        deliveries,
        {
          beforeDeliver: () => {
            olderBeforeDeliverStarted.resolve();
            return releaseOlderBeforeDeliver.promise;
          },
        },
      );
      await olderBeforeDeliverStarted.promise;
      const newerDispatch = dispatchWithDeliveries(
        buildForegroundCtx({ MessageSid: "new-message" }),
        deliveries,
        {
          [settledHook]: () => {
            deliveries.push({ kind: "final", text: "new settled final" });
            return { visibleReplySent: true };
          },
        },
      );
      await newerStarted.promise;

      releaseOlderBeforeDeliver.resolve({ text: "old final" });
      await Promise.all([olderDispatch, newerDispatch]);

      expect(deliveries).toEqual([
        { kind: "final", text: "old final" },
        { kind: "final", text: "new settled final" },
      ]);
    },
  );

  it("releases a same-target successor when an earlier dispatch fails", async () => {
    const deliveries: Delivery[] = [];
    const olderStarted = createDeferred();
    const newerStarted = createDeferred();
    const releaseOlderFailure = createDeferred();
    const error = new Error("resolver failed");

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "older") {
          olderStarted.resolve();
          await releaseOlderFailure.promise;
          throw error;
        }
        newerStarted.resolve();
        params.dispatcher.sendFinalReply({ text: "newer final" });
        return queuedFinalResult();
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "older" }),
      deliveries,
    );
    await olderStarted.promise;
    const newerDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "newer" }),
      deliveries,
    );
    await newerStarted.promise;
    expect(deliveries).toEqual([]);

    releaseOlderFailure.resolve();
    await expect(olderDispatch).rejects.toBe(error);
    await expect(newerDispatch).resolves.toEqual(settledFinalResult());
    expect(deliveries).toEqual([{ kind: "final", text: "newer final" }]);
  });

  it("keeps concurrent foreground finals isolated for different targets sharing a session", async () => {
    const deliveries: Delivery[] = [];
    const firstStarted = createDeferred();
    const releaseFirstFinal = createDeferred();

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "first-chat") {
          firstStarted.resolve();
          await releaseFirstFinal.promise;
          params.dispatcher.sendFinalReply({ text: "first chat final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "second-chat") {
          params.dispatcher.sendFinalReply({ text: "second chat final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const sharedSessionKey = "agent:main:main";
    const firstDispatch = dispatchWithDeliveries(
      buildForegroundCtx({
        MessageSid: "first-chat",
        SessionKey: sharedSessionKey,
        From: "whatsapp:+1000",
        OriginatingTo: "whatsapp:+1000",
      }),
      deliveries,
    );
    await firstStarted.promise;

    const secondDispatch = dispatchWithDeliveries(
      buildForegroundCtx({
        MessageSid: "second-chat",
        SessionKey: sharedSessionKey,
        From: "whatsapp:+3000",
        OriginatingTo: "whatsapp:+3000",
      }),
      deliveries,
    );
    await expect(secondDispatch).resolves.toEqual(settledFinalResult());

    releaseFirstFinal.resolve();
    await expect(firstDispatch).resolves.toEqual(settledFinalResult());
    expect(deliveries).toEqual([
      { kind: "final", text: "second chat final" },
      { kind: "final", text: "first chat final" },
    ]);
  });

  it.each(["status command", "queue admission notice"] as const)(
    "delivers %s immediately while later ordinary output retains the active turn's fence",
    async (noticeKind) => {
      const deliveries: Delivery[] = [];
      const olderStarted = createDeferred();
      const releaseOlderFinal = createDeferred();
      const newerStarted = createDeferred();
      const beforeDeliver = vi.fn(async (payload: ReplyPayload) => payload);
      const onSettled = vi.fn();
      const onFreshSettledDelivery = vi.fn();
      const notice = "Runtime notice";
      const pending: Promise<unknown>[] = [];
      hoisted.dispatchReplyFromConfigMock.mockImplementation(
        async (params: DispatchReplyFromConfigParams) => {
          if (params.ctx.MessageSid === "old-message") {
            olderStarted.resolve();
            await releaseOlderFinal.promise;
            params.dispatcher.sendFinalReply({ text: "old final" });
          } else if (params.ctx.MessageSid === "notice-message") {
            const payload = { text: notice, isStatusNotice: true };
            params.dispatcher.sendFinalReply(
              noticeKind === "queue admission notice"
                ? setReplyPayloadMetadata(payload, { queueAdmissionNotice: true })
                : payload,
            );
          } else {
            newerStarted.resolve();
            // A generic status flag is not an admission acknowledgment.
            params.dispatcher.sendFinalReply({ text: "new status", isStatusNotice: true });
          }
          return queuedFinalResult();
        },
      );
      try {
        const olderDispatch = dispatchWithDeliveries(
          buildForegroundCtx({ MessageSid: "old-message" }),
          deliveries,
        );
        pending.push(olderDispatch);
        await olderStarted.promise;
        const noticeDispatch = dispatchWithDeliveries(
          buildForegroundCtx({
            MessageSid: "notice-message",
            ...(noticeKind === "status command"
              ? {
                  CommandAuthorized: true,
                  CommandSource: "text" as const,
                  CommandTurn: {
                    kind: "text-slash" as const,
                    source: "text" as const,
                    authorized: true,
                    commandName: "status",
                    body: "/status",
                  },
                  Body: "/status",
                  RawBody: "/status",
                  CommandBody: "/status",
                  BodyForAgent: "/status",
                }
              : {}),
          }),
          deliveries,
          { beforeDeliver, onSettled, onFreshSettledDelivery },
        );
        pending.push(noticeDispatch);
        await expect(noticeDispatch).resolves.toEqual(settledFinalResult());
        expect(beforeDeliver).toHaveBeenCalledOnce();
        expect(onSettled).toHaveBeenCalledOnce();
        expect(onFreshSettledDelivery).toHaveBeenCalledOnce();
        const newerDispatch = dispatchWithDeliveries(
          buildForegroundCtx({ MessageSid: "new-message" }),
          deliveries,
        );
        pending.push(newerDispatch);
        await newerStarted.promise;
        expect(deliveries).toEqual([{ kind: "final", text: notice }]);
        releaseOlderFinal.resolve();
        await Promise.all([olderDispatch, newerDispatch]);
        expect(deliveries).toEqual([
          { kind: "final", text: notice },
          { kind: "final", text: "old final" },
          { kind: "final", text: "new status" },
        ]);
      } finally {
        releaseOlderFinal.resolve();
        await Promise.allSettled(pending);
      }
    },
  );
});
