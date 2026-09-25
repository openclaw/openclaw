import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import type { OutboundPayloadPlan } from "../../infra/outbound/reply-payload-parts.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  diagnosticMocks,
  emptyConfig,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { dispatchReplyFromConfig, setNoAbort } from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

// The delivery entrypoint owns the shared harness and per-case runtime snapshot cleanup.
export function registerPreparedSettlementTests() {
  it.each(["prepared", "legacy"] as const)(
    "settles a prepared block through a %s dispatcher without sending a duplicate final",
    async (mode) => {
      setNoAbort();
      const rawDeliver = vi.fn(async (_payload: ReplyPayload) => ({ visibleReplySent: true }));
      const preparedDeliver = vi.fn(async (_plan: OutboundPayloadPlan) => ({
        visibleReplySent: true,
      }));
      const owner = createReplyDispatcher({
        deliver: rawDeliver,
        deliverPrepared: preparedDeliver,
      });
      const dispatcher = mode === "legacy" ? { ...owner, sendPreparedReply: undefined } : owner;
      const onBlockReplyQueued = vi.fn();
      const payload = setReplyPayloadMetadata(
        { text: "literal [[reply_to:example]] and [[audio_as_voice]] tail" },
        { assistantMessageIndex: 7 },
      );
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: { onBlockReplyQueued },
        replyResolver: async (_ctx, opts) => {
          const plan = expectDefined(
            createStructuredOutboundPayloadPlan([payload])[0],
            "prepared block",
          );
          await opts?.onPreparedBlockReply?.(plan);
          return payload;
        },
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(result.counts).toEqual({ tool: 0, block: 1, final: 0 });
      expect(onBlockReplyQueued).toHaveBeenCalledOnce();
      expect(onBlockReplyQueued.mock.calls[0]?.[1]).toMatchObject({ assistantMessageIndex: 7 });
      const deliveredPayload = expectDefined(
        mode === "prepared"
          ? preparedDeliver.mock.calls[0]?.[0].payload
          : rawDeliver.mock.calls[0]?.[0],
        "delivered block",
      );
      expect(deliveredPayload).toMatchObject({ text: payload.text });
      expect(getReplyPayloadMetadata(deliveredPayload)).toMatchObject({ assistantMessageIndex: 7 });
      expect(preparedDeliver).toHaveBeenCalledTimes(mode === "prepared" ? 1 : 0);
      expect(rawDeliver).toHaveBeenCalledTimes(mode === "legacy" ? 1 : 0);
    },
  );

  it("records channel transform suppression before TTS or visible fallback delivery", async () => {
    setNoAbort();
    const transport = vi.fn(async () => {});
    const transformReplyPayload = vi.fn(() => null);
    const dispatcher = createReplyDispatcher({ deliver: transport, transformReplyPayload });
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      SessionKey: "agent:main:telegram:direct:123",
    });

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver: vi.fn(async (_ctx, opts) => {
        await opts?.onBlockReply?.({ text: "private block" });
        return { text: "private reply" };
      }),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(result).not.toHaveProperty("noVisibleReplyFallbackEligible");
    expect(result).not.toHaveProperty("noVisibleReplyFallbackDelivered");
    expect(transformReplyPayload).toHaveBeenCalledTimes(2);
    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", reason: "channel_transform" }),
    );
  });
}
