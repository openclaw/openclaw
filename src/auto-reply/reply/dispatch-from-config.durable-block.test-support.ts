// Registered inside the dispatch suite so its shared mocks and lifecycle stay authoritative.
import { expect, it, vi } from "vitest";
import { deliverAgentHarnessUserInputPrompt } from "../../agents/harness/user-input-bridge.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  acpMocks,
  createDispatcher,
  emptyConfig,
  mocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  createDispatchGate,
  dispatchReplyFromConfig,
  firstRouteReplyCall,
  installThreadingTestPlugin,
  requireBlockReplyHandler,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { createBlockReplyDeliveryHandler, type DirectBlockDelivery } from "./reply-delivery.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createTypingSignaler } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

function telegramCtx(overrides: Partial<MsgContext> = {}) {
  return buildTestCtx({
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:999",
    ...overrides,
  });
}

function privateWebchatCtx(ExplicitDeliverRoute?: boolean) {
  return buildTestCtx({
    Provider: "webchat",
    Surface: "webchat",
    OriginatingChannel: "imessage",
    OriginatingTo: "imessage:+15550001111",
    ...(ExplicitDeliverRoute === undefined ? {} : { ExplicitDeliverRoute }),
  });
}

function blockReply(text: string, deliveryIntentId?: string) {
  return async (_ctx: MsgContext, opts?: GetReplyOptions) => {
    await requireBlockReplyHandler(opts?.onBlockReply)(
      { text },
      deliveryIntentId ? { deliveryIntentId } : undefined,
    );
  };
}

type DispatchInput = Parameters<typeof dispatchReplyFromConfig>[0];

function blockTest() {
  setNoAbort();
  mocks.routeReply.mockClear();
  const dispatcher = createDispatcher();
  const run = (
    ctx: DispatchInput["ctx"],
    replyResolver: DispatchInput["replyResolver"],
    replyOptions?: DispatchInput["replyOptions"],
    cfg: DispatchInput["cfg"] = automaticDirectReplyConfig,
  ) => dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver, replyOptions });
  return { dispatcher, run };
}

export function registerDurableBlockRoutingTests(): void {
  it.each([
    [
      "never lets a durable block intent route a private webchat turn to an inherited external recipient",
      "private",
      "Private dashboard update",
    ],
    [
      "never lets a durable block intent deliver directly from a parent-owned background session",
      "child",
      "Private delegated progress",
    ],
    [
      "keeps same-channel blocks without a stable intent on the dispatcher",
      "ordinary",
      "ordinary block",
    ],
  ] as const)("%s", async (_name, kind, text) => {
    if (kind !== "ordinary") {
      installThreadingTestPlugin({ id: kind === "private" ? "imessage" : "telegram" });
    }
    if (kind === "child") {
      sessionStoreMocks.currentEntry = {
        sessionId: "background-child",
        spawnedBy: "agent:main:parent",
      };
      acpMocks.readAcpSessionEntry.mockReturnValue({
        agentId: "main",
        sessionKey: "agent:main:background-child",
        entry: sessionStoreMocks.currentEntry,
        acp: {
          backend: "acpx",
          agent: "fixture",
          runtimeSessionName: "background-child",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        },
      });
    }
    const ctx =
      kind === "private"
        ? privateWebchatCtx()
        : telegramCtx(kind === "child" ? { SessionKey: "agent:main:background-child" } : {});
    const intent =
      kind === "ordinary" ? undefined : `block-reply:v1:codex-app-server:thread-1:turn-1:${kind}`;
    const { dispatcher, run } = blockTest();
    await run(ctx, blockReply(text, intent));
    expect(mocks.routeReply).not.toHaveBeenCalled();
    if (kind === "child") {
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    } else {
      expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({ text });
    }
  });

  it("routes external origin replies for internal webchat turns when explicit delivery is set", async () => {
    installThreadingTestPlugin({ id: "imessage" });
    const { dispatcher, run } = blockTest();
    const ctx = privateWebchatCtx(true);

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await run(ctx, replyResolver, undefined, emptyConfig);

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(firstRouteReplyCall()).toMatchObject({
      channel: "imessage",
      policyConversationType: "direct",
      to: "imessage:+15550001111",
    });
  });

  it.each(["delivered", "held", "released"] as const)(
    "settles native async blocks through the adapter without suppressing an identical final (%s)",
    async (custody) => {
      setNoAbort();
      installThreadingTestPlugin({ id: "discord" });
      const delivered: string[] = [];
      const failure = new PlatformMessageNotDispatchedError("Synthetic channel unavailable", {
        cause: undefined,
      });
      let attempts = 0;
      mocks.routeReply
        .mockReset()
        .mockImplementation(async ({ payload }: { payload: ReplyPayload }) => {
          attempts += 1;
          if (attempts === 1 && custody !== "delivered") {
            return {
              ok: false,
              delivered: false,
              queueCustody: custody,
              error: failure.message,
              cause: failure,
            };
          }
          delivered.push(payload.text ?? "");
          return { ok: true, delivered: true, messageId: "independent-message" };
        });
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload.text ?? "");
        },
      });
      const deliveryIntentId = "block-reply:v1:codex-app-server:thread-1:turn-1:item-1";
      const abortSignal = new AbortController().signal;
      const text = "The selected environment is ready.";
      const ctx = buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:123",
      });
      const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
        const directBlockDeliveries: DirectBlockDelivery[] = [];
        const onBlockReply = createBlockReplyDeliveryHandler({
          onBlockReply: requireBlockReplyHandler(opts?.onBlockReply),
          normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
          applyReplyToMode: (payload) => payload,
          typingSignals: createTypingSignaler({
            typing: createTypingController({}),
            mode: "never",
            isHeartbeat: false,
          }),
          blockStreamingEnabled: false,
          blockReplyPipeline: null,
          directBlockDeliveries,
        });
        const send = () =>
          deliverAgentHarnessUserInputPrompt(
            { onBlockReply: (payload) => onBlockReply(payload, { deliveryIntentId, abortSignal }) },
            [],
            { intro: text },
          );
        if (custody === "released") {
          await expect(send()).rejects.toThrow(failure.message);
          expect(directBlockDeliveries[0]).toMatchObject({
            outcome: "failed-before-deliver",
            pending: false,
          });
        }
        await send();
        if (custody === "held") {
          expect(directBlockDeliveries[0]).toMatchObject({
            outcome: "recovery-owned",
            pending: true,
          });
        }
        expect(delivered).toEqual(custody === "held" ? [] : [text]);
        return { text };
      };

      try {
        await dispatchReplyFromConfig({
          ctx,
          cfg: automaticDirectReplyConfig,
          dispatcher,
          replyResolver,
        });
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }

      expect(delivered).toEqual(custody === "held" ? [text] : [text, text]);
      expect(mocks.routeReply).toHaveBeenCalledTimes(custody === "released" ? 2 : 1);
      expect(mocks.routeReply).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ text }),
          abortSignal,
          replyKind: "block",
          deliveryIntentId,
        }),
      );
    },
  );

  it("keeps same-channel stable block delivery on the resolved source account", async () => {
    installThreadingTestPlugin({
      id: "telegram",
      defaultAccountId: "default",
      resolveReplyToMode: ({ accountId }) => (accountId === "work" ? "off" : "all"),
    });
    sessionStoreMocks.currentEntry = { ttsAuto: "always" };
    const { dispatcher, run } = blockTest();
    const deliveryIntentId = "block-reply:v1:codex-app-server:thread-1:turn-1:item-same";
    const custody = createDispatchGate();
    mocks.routeReply.mockImplementationOnce(async () => {
      await custody.wait();
      return { ok: true, delivered: true, messageId: "durable" };
    });
    ttsMocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
      text: "durable background update",
      mediaUrl: "https://example.com/block-tts.opus",
      audioAsVoice: true,
    });
    const onBlockReplyQueued = vi.fn();
    let blockSettled = false;
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const block = Promise.resolve(
        requireBlockReplyHandler(opts?.onBlockReply)(
          { text: "durable background update" },
          { deliveryIntentId },
        ),
      ).then(() => {
        blockSettled = true;
      });
      await vi.waitFor(() => expect(mocks.routeReply).toHaveBeenCalledOnce());
      await custody.started;
      expect(blockSettled).toBe(false);
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      custody.resolve();
      await block;
      return undefined;
    };

    await run(telegramCtx({ AccountId: "work" }), replyResolver, { onBlockReplyQueued });

    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          text: "durable background update",
          mediaUrl: "https://example.com/block-tts.opus",
          audioAsVoice: true,
        }),
        accountId: "work",
        replyDelivery: { chatType: "direct", replyToMode: "off" },
        replyKind: "block",
        deliveryIntentId,
      }),
    );
    expect(onBlockReplyQueued).toHaveBeenCalledOnce();
  });

  it("rejects failed same-channel stable admission and retries the same intent", async () => {
    const deliveryIntentId = "block-reply:v1:codex-app-server:thread-1:turn-1:item-retry";
    mocks.routeReply
      .mockReset()
      .mockResolvedValueOnce({ ok: false, delivered: false, error: "durable queue unavailable" })
      .mockResolvedValueOnce({ ok: true, delivered: true, messageId: "retried" });
    installThreadingTestPlugin({ id: "telegram" });
    const { dispatcher, run } = blockTest();
    const ctx = telegramCtx();
    const dispatch = () => run(ctx, blockReply("retry this update", deliveryIntentId));

    await expect(dispatch()).rejects.toThrow("durable queue unavailable");
    await expect(dispatch()).resolves.toBeDefined();

    expect(mocks.routeReply).toHaveBeenCalledTimes(2);
    expect(mocks.routeReply.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({ deliveryIntentId }),
      expect.objectContaining({ deliveryIntentId }),
    ]);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("returns durable routed block failures to the producing runtime", async () => {
    mocks.routeReply
      .mockReset()
      .mockResolvedValue({ ok: false, delivered: false, error: "durable queue unavailable" });
    installThreadingTestPlugin({ id: "telegram" });
    const { run } = blockTest();
    const ctx = buildTestCtx({
      Provider: "slack",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });
    const replyResolver = blockReply(
      "retry this update",
      "block-reply:v1:codex-app-server:thread-1:turn-1:item-2",
    );

    await expect(run(ctx, replyResolver)).rejects.toThrow("durable queue unavailable");
  });
}
