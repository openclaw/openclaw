/** Tests foreground reply delivery ordering for buffered inbound dispatch. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
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

const finals = (...texts: string[]): Delivery[] => texts.map((text) => ({ kind: "final", text }));

function sendFinal(params: DispatchReplyFromConfigParams, text: string) {
  params.dispatcher.sendFinalReply({ text });
  return queuedFinalResult();
}

function queuedFinalResult() {
  return {
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  };
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
      counts: {
        tool: counts(0),
        block: counts(0),
        final: counts(1),
      },
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
  message: string | FinalizedMsgContext,
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
    ctx: typeof message === "string" ? buildForegroundCtx(message) : message,
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
          return sendFinal(params, "old final");
        }
        if (params.ctx.MessageSid === "waiting-message") {
          waitingSuccessorStarted.resolve();
          await releaseWaitingSuccessor.promise;
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        }
        if (params.ctx.MessageSid === "new-message") {
          newestStarted.resolve();
          return sendFinal(params, "new final");
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries("old-message", deliveries, {
      beforeDeliver: () => {
        olderBeforeDeliverStarted.resolve();
        return releaseOlderBeforeDeliver.promise;
      },
    });
    await olderBeforeDeliverStarted.promise;

    const waitingSuccessorDispatch = dispatchWithDeliveries("waiting-message", deliveries);
    await waitingSuccessorStarted.promise;
    const newestDispatch = dispatchWithDeliveries("new-message", deliveries);
    await newestStarted.promise;

    releaseOlderBeforeDeliver.resolve({ text: "old final" });
    await olderDispatch;
    expect(deliveries).toEqual(finals("old final"));

    releaseWaitingSuccessor.resolve();
    await Promise.all([waitingSuccessorDispatch, newestDispatch]);

    expect(deliveries).toEqual(finals("old final", "new final"));
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
          return sendFinal(params, `${params.ctx.MessageSid} final`);
        },
      );

      const olderDispatch = dispatchWithDeliveries("older", deliveries, {
        beforeDeliver: () => {
          olderHookStarted.resolve();
          return releaseOlderHook.promise;
        },
        beforeDeliverOptions: { timeoutMs: 40_000 },
      });
      await olderHookStarted.promise;
      const newerDispatch = dispatchWithDeliveries("newer", deliveries, {
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
      releaseOlderHook.resolve({ text: "older final" });
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
    const olderStarted = createDeferred();
    const newerStarted = createDeferred();
    const releaseOlderFinal = createDeferred();
    const olderDelivered = createDeferred();

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          olderStarted.resolve();
          await releaseOlderFinal.promise;
          return sendFinal(params, "old final");
        }
        if (params.ctx.MessageSid === "new-message") {
          newerStarted.resolve();
          // Same-session follow-up admission waits for the owning final delivery.
          await olderDelivered.promise;
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries("old-message", deliveries, {
      deliver: async (payload, info) => {
        deliveries.push({ kind: info.kind, text: payload.text });
        olderDelivered.resolve();
      },
    });
    await olderStarted.promise;

    const newerDispatch = dispatchWithDeliveries("new-message", deliveries);
    await newerStarted.promise;
    releaseOlderFinal.resolve();

    await expect(olderDispatch).resolves.toEqual(settledFinalResult());
    const newerResult = await newerDispatch;
    expect(newerResult).toMatchObject(expectedNoQueuedReplyResult());
    expect(newerResult.settledReceipt?.anyVisibleDelivered).toBe(false);
    expect(deliveries).toEqual(finals("old final"));
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
            return sendFinal(params, "old final");
          }
          if (params.ctx.MessageSid === "new-message") {
            newerStarted.resolve();
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
          }
          throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
        },
      );

      const olderDispatch = dispatchWithDeliveries("old-message", deliveries, {
        beforeDeliver: () => {
          olderBeforeDeliverStarted.resolve();
          return releaseOlderBeforeDeliver.promise;
        },
      });
      await olderBeforeDeliverStarted.promise;
      const newerDispatch = dispatchWithDeliveries("new-message", deliveries, {
        [settledHook]: () => {
          deliveries.push({ kind: "final", text: "new settled final" });
          return { visibleReplySent: true };
        },
      });
      await newerStarted.promise;

      releaseOlderBeforeDeliver.resolve({ text: "old final" });
      await Promise.all([olderDispatch, newerDispatch]);

      expect(deliveries).toEqual(finals("old final", "new settled final"));
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
        return sendFinal(params, "newer final");
      },
    );

    const olderDispatch = dispatchWithDeliveries("older", deliveries);
    await olderStarted.promise;
    const newerDispatch = dispatchWithDeliveries("newer", deliveries);
    await newerStarted.promise;
    expect(deliveries).toEqual([]);

    releaseOlderFailure.resolve();
    await expect(olderDispatch).rejects.toBe(error);
    await expect(newerDispatch).resolves.toEqual(settledFinalResult());
    expect(deliveries).toEqual(finals("newer final"));
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
          return sendFinal(params, "first chat final");
        }
        if (params.ctx.MessageSid === "second-chat") {
          return sendFinal(params, "second chat final");
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const sharedSessionKey = "agent:main:main";
    const firstDispatch = dispatchWithDeliveries(
      buildForegroundCtx("first-chat", {
        SessionKey: sharedSessionKey,
        From: "whatsapp:+1000",
        OriginatingTo: "whatsapp:+1000",
      }),
      deliveries,
    );
    await firstStarted.promise;

    const secondDispatch = dispatchWithDeliveries(
      buildForegroundCtx("second-chat", {
        SessionKey: sharedSessionKey,
        From: "whatsapp:+3000",
        OriginatingTo: "whatsapp:+3000",
      }),
      deliveries,
    );
    await expect(secondDispatch).resolves.toEqual(settledFinalResult());

    releaseFirstFinal.resolve();
    await expect(firstDispatch).resolves.toEqual(settledFinalResult());
    expect(deliveries).toEqual(finals("second chat final", "first chat final"));
  });

  it("delivers same-session /status while an earlier foreground turn still holds the fence", async () => {
    const deliveries: Delivery[] = [];
    const olderStarted = createDeferred();
    const releaseOlderFinal = createDeferred();

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          olderStarted.resolve();
          await releaseOlderFinal.promise;
          return sendFinal(params, "old final");
        }
        if (params.ctx.MessageSid === "status-message") {
          return sendFinal(params, "🧠 Model: mock | ⚙️ Status: ok");
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries("old-message", deliveries);
    await olderStarted.promise;

    const statusDispatch = dispatchWithDeliveries(
      buildForegroundCtx("status-message", {
        CommandAuthorized: true,
        CommandSource: "text",
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: true,
          commandName: "status",
          body: "/status",
        },
        Body: "/status",
        RawBody: "/status",
        CommandBody: "/status",
        BodyForAgent: "/status",
      }),
      deliveries,
    );

    await expect(statusDispatch).resolves.toEqual(settledFinalResult());
    expect(deliveries).toEqual(finals("🧠 Model: mock | ⚙️ Status: ok"));

    releaseOlderFinal.resolve();
    await expect(olderDispatch).resolves.toEqual(settledFinalResult());
    expect(deliveries).toEqual(finals("🧠 Model: mock | ⚙️ Status: ok", "old final"));
  });
});
