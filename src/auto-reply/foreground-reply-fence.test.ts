/** Tests the bounded foreground fence wait and tool-payload park exemption. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { getReplyPayloadMetadata } from "./reply-payload.js";
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
const { FOREGROUND_REPLY_FENCE_WAIT_TIMEOUT_MS } = await import("./foreground-reply-fence.js");

type Delivery = {
  kind: "tool" | "block" | "final";
  text: string | undefined;
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function queuedFinalResult() {
  return {
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
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
    onBeforeDeliverCancelled?: (payload: ReplyPayload, info: { kind: Delivery["kind"] }) => void;
    onFreshSettledDelivery?: () => object | void | Promise<object | void>;
  } = {},
) {
  return dispatchInboundMessageWithBufferedDispatcher({
    ctx,
    cfg: {} as OpenClawConfig,
    dispatcherOptions: {
      ...dispatcherOptions,
      deliver: async (payload: ReplyPayload, info: { kind: Delivery["kind"] }) => {
        deliveries.push({ kind: info.kind, text: payload.text });
      },
    },
  });
}

describe("foreground fence bounded wait", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    hoisted.dispatchReplyFromConfigMock.mockReset();
  });

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it(
    "releases an older foreground final after the fence wait budget expires",
    {
      timeout: 15_000,
    },
    async () => {
      vi.useFakeTimers();
      const deliveries: Delivery[] = [];
      const olderStarted = createDeferred<void>();
      const releaseOlderFinal = createDeferred<void>();
      const newerStarted = createDeferred<void>();
      const releaseNewerRun = createDeferred<void>();
      let olderDispatch: Promise<unknown> = Promise.resolve();
      let newerDispatch: Promise<unknown> = Promise.resolve();
      try {
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
              // Stays active without any visible delivery, like a long agent run.
              await releaseNewerRun.promise;
              return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
            }
            throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
          },
        );

        olderDispatch = dispatchWithDeliveries(
          buildForegroundCtx({ MessageSid: "old-message" }),
          deliveries,
        );
        await olderStarted.promise;

        newerDispatch = dispatchWithDeliveries(
          buildForegroundCtx({ MessageSid: "new-message" }),
          deliveries,
        );
        await newerStarted.promise;

        releaseOlderFinal.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(deliveries).toEqual([]);

        await vi.advanceTimersByTimeAsync(FOREGROUND_REPLY_FENCE_WAIT_TIMEOUT_MS - 1);
        expect(deliveries).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        await expect(olderDispatch).resolves.toEqual(queuedFinalResult());
        expect(deliveries).toEqual([{ kind: "final", text: "old final" }]);

        releaseNewerRun.resolve();
        await expect(newerDispatch).resolves.toEqual({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        // Unwind on failure so a regression here cannot strand later tests.
        releaseOlderFinal.resolve();
        releaseNewerRun.resolve();
        await vi.advanceTimersByTimeAsync(FOREGROUND_REPLY_FENCE_WAIT_TIMEOUT_MS * 2);
        await Promise.allSettled([olderDispatch, newerDispatch]);
        vi.useRealTimers();
      }
    },
  );

  it(
    "still suppresses an older final when the newer turn delivers within the fence wait budget",
    {
      timeout: 15_000,
    },
    async () => {
      vi.useFakeTimers();
      const deliveries: Delivery[] = [];
      const cancellationReasons: Array<string | undefined> = [];
      const olderStarted = createDeferred<void>();
      const releaseOlderFinal = createDeferred<void>();
      const newerStarted = createDeferred<void>();
      const releaseNewerFinal = createDeferred<void>();
      let olderDispatch: Promise<unknown> = Promise.resolve();
      let newerDispatch: Promise<unknown> = Promise.resolve();
      try {
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
              await releaseNewerFinal.promise;
              params.dispatcher.sendFinalReply({ text: "new final" });
              return queuedFinalResult();
            }
            throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
          },
        );

        olderDispatch = dispatchWithDeliveries(
          buildForegroundCtx({ MessageSid: "old-message" }),
          deliveries,
          {
            onBeforeDeliverCancelled: (payload) => {
              cancellationReasons.push(
                getReplyPayloadMetadata(payload)?.foregroundDeliverySuppression?.reason,
              );
            },
          },
        );
        await olderStarted.promise;

        newerDispatch = dispatchWithDeliveries(
          buildForegroundCtx({ MessageSid: "new-message" }),
          deliveries,
        );
        await newerStarted.promise;

        releaseOlderFinal.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(deliveries).toEqual([]);

        await vi.advanceTimersByTimeAsync(5_000);
        releaseNewerFinal.resolve();
        await expect(newerDispatch).resolves.toEqual(queuedFinalResult());
        await expect(olderDispatch).resolves.toEqual({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        });
        expect(deliveries).toEqual([{ kind: "final", text: "new final" }]);
        expect(cancellationReasons).toEqual(["stale-foreground"]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        releaseOlderFinal.resolve();
        releaseNewerFinal.resolve();
        await vi.advanceTimersByTimeAsync(FOREGROUND_REPLY_FENCE_WAIT_TIMEOUT_MS * 2);
        await Promise.allSettled([olderDispatch, newerDispatch]);
        vi.useRealTimers();
      }
    },
  );

  it("does not fence an older tool payload behind a newer active turn", async () => {
    const deliveries: Delivery[] = [];
    const cancellationReasons: Array<string | undefined> = [];
    const olderStarted = createDeferred<void>();
    const releaseOlderSends = createDeferred<void>();
    const newerStarted = createDeferred<void>();
    const releaseNewerFinal = createDeferred<void>();
    let olderDispatch: Promise<unknown> = Promise.resolve();
    let newerDispatch: Promise<unknown> = Promise.resolve();
    try {
      hoisted.dispatchReplyFromConfigMock.mockImplementation(
        async (params: DispatchReplyFromConfigParams) => {
          if (params.ctx.MessageSid === "old-message") {
            olderStarted.resolve();
            await releaseOlderSends.promise;
            params.dispatcher.sendToolResult({ text: "old tool status" });
            params.dispatcher.sendFinalReply({ text: "old final" });
            return { queuedFinal: true, counts: { tool: 1, block: 0, final: 1 } };
          }
          if (params.ctx.MessageSid === "new-message") {
            newerStarted.resolve();
            await releaseNewerFinal.promise;
            params.dispatcher.sendFinalReply({ text: "new final" });
            return queuedFinalResult();
          }
          throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
        },
      );

      olderDispatch = dispatchWithDeliveries(
        buildForegroundCtx({ MessageSid: "old-message" }),
        deliveries,
        {
          onBeforeDeliverCancelled: (payload) => {
            cancellationReasons.push(
              getReplyPayloadMetadata(payload)?.foregroundDeliverySuppression?.reason,
            );
          },
        },
      );
      await olderStarted.promise;

      newerDispatch = dispatchWithDeliveries(
        buildForegroundCtx({ MessageSid: "new-message" }),
        deliveries,
      );
      await newerStarted.promise;

      releaseOlderSends.resolve();
      await vi.waitFor(() => {
        expect(deliveries).toEqual([{ kind: "tool", text: "old tool status" }]);
      });

      releaseNewerFinal.resolve();
      await expect(newerDispatch).resolves.toEqual(queuedFinalResult());
      await expect(olderDispatch).resolves.toEqual({
        queuedFinal: false,
        counts: { tool: 1, block: 0, final: 0 },
      });
      expect(deliveries).toEqual([
        { kind: "tool", text: "old tool status" },
        { kind: "final", text: "new final" },
      ]);
      expect(cancellationReasons).toEqual(["stale-foreground"]);
    } finally {
      releaseOlderSends.resolve();
      releaseNewerFinal.resolve();
      await Promise.allSettled([olderDispatch, newerDispatch]);
    }
  });

  it("cancels an older tool payload that is already stale behind a newer visible final", async () => {
    const deliveries: Delivery[] = [];
    const cancellationReasons: Array<string | undefined> = [];
    const olderStarted = createDeferred<void>();
    const releaseOlderSends = createDeferred<void>();
    let olderDispatch: Promise<unknown> = Promise.resolve();
    try {
      hoisted.dispatchReplyFromConfigMock.mockImplementation(
        async (params: DispatchReplyFromConfigParams) => {
          if (params.ctx.MessageSid === "old-message") {
            olderStarted.resolve();
            await releaseOlderSends.promise;
            params.dispatcher.sendToolResult({ text: "old tool status" });
            params.dispatcher.sendFinalReply({ text: "old final" });
            return { queuedFinal: true, counts: { tool: 1, block: 0, final: 1 } };
          }
          if (params.ctx.MessageSid === "new-message") {
            params.dispatcher.sendFinalReply({ text: "new final" });
            return queuedFinalResult();
          }
          throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
        },
      );

      olderDispatch = dispatchWithDeliveries(
        buildForegroundCtx({ MessageSid: "old-message" }),
        deliveries,
        {
          onBeforeDeliverCancelled: (payload) => {
            cancellationReasons.push(
              getReplyPayloadMetadata(payload)?.foregroundDeliverySuppression?.reason,
            );
          },
        },
      );
      await olderStarted.promise;

      await expect(
        dispatchWithDeliveries(buildForegroundCtx({ MessageSid: "new-message" }), deliveries),
      ).resolves.toEqual(queuedFinalResult());

      releaseOlderSends.resolve();
      await expect(olderDispatch).resolves.toEqual({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      });
      expect(deliveries).toEqual([{ kind: "final", text: "new final" }]);
      expect(cancellationReasons).toEqual(["stale-foreground", "stale-foreground"]);
    } finally {
      releaseOlderSends.resolve();
      await Promise.allSettled([olderDispatch]);
    }
  });

  it(
    "runs a fresh settled delivery after the fence wait budget expires",
    {
      timeout: 15_000,
    },
    async () => {
      vi.useFakeTimers();
      const deliveries: Delivery[] = [];
      const olderStarted = createDeferred<void>();
      const releaseOlderReturn = createDeferred<void>();
      const newerStarted = createDeferred<void>();
      const releaseNewerRun = createDeferred<void>();
      let freshSettledCalls = 0;
      let olderDispatch: Promise<unknown> = Promise.resolve();
      let newerDispatch: Promise<unknown> = Promise.resolve();
      try {
        hoisted.dispatchReplyFromConfigMock.mockImplementation(
          async (params: DispatchReplyFromConfigParams) => {
            if (params.ctx.MessageSid === "old-message") {
              olderStarted.resolve();
              await releaseOlderReturn.promise;
              return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
            }
            if (params.ctx.MessageSid === "new-message") {
              newerStarted.resolve();
              await releaseNewerRun.promise;
              return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
            }
            throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
          },
        );

        olderDispatch = dispatchWithDeliveries(
          buildForegroundCtx({ MessageSid: "old-message" }),
          deliveries,
          {
            onFreshSettledDelivery: () => {
              freshSettledCalls += 1;
              return { visibleReplySent: true };
            },
          },
        );
        await olderStarted.promise;

        newerDispatch = dispatchWithDeliveries(
          buildForegroundCtx({ MessageSid: "new-message" }),
          deliveries,
        );
        await newerStarted.promise;

        releaseOlderReturn.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(freshSettledCalls).toBe(0);

        await vi.advanceTimersByTimeAsync(FOREGROUND_REPLY_FENCE_WAIT_TIMEOUT_MS - 1);
        expect(freshSettledCalls).toBe(0);

        await vi.advanceTimersByTimeAsync(1);
        await olderDispatch;
        expect(freshSettledCalls).toBe(1);

        releaseNewerRun.resolve();
        await newerDispatch;
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        releaseOlderReturn.resolve();
        releaseNewerRun.resolve();
        await vi.advanceTimersByTimeAsync(FOREGROUND_REPLY_FENCE_WAIT_TIMEOUT_MS * 2);
        await Promise.allSettled([olderDispatch, newerDispatch]);
        vi.useRealTimers();
      }
    },
  );
});
