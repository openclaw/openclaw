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
import { dispatchReplyFromConfig, setNoAbort } from "./dispatch-from-config.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

export function registerPreparedSettlementTests() {
  it.each(["prepared", "legacy"] as const)(
    "settles prepared blocks through %s dispatch without duplicate finals",
    async (mode) => {
      setNoAbort();
      const receipt = { visibleReplySent: true };
      const deliver = vi.fn(async (_payload: ReplyPayload) => receipt);
      const deliverPrepared = vi.fn(async (_plan: OutboundPayloadPlan) => receipt);
      const owner = createReplyDispatcher({ deliver, deliverPrepared });
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
          const [plan] = createStructuredOutboundPayloadPlan([payload]);
          await opts?.onPreparedBlockReply?.(expectDefined(plan, "prepared block"));
          return payload;
        },
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(result.counts).toEqual({ tool: 0, block: 1, final: 0 });
      expect(onBlockReplyQueued).toHaveBeenCalledOnce();
      expect(onBlockReplyQueued.mock.calls[0]?.[1]).toMatchObject({ assistantMessageIndex: 7 });
      const delivered = expectDefined(
        mode === "prepared"
          ? deliverPrepared.mock.calls[0]?.[0].payload
          : deliver.mock.calls[0]?.[0],
        "delivered block",
      );
      expect(delivered).toMatchObject({ text: payload.text });
      expect(getReplyPayloadMetadata(delivered)).toMatchObject({ assistantMessageIndex: 7 });
      expect(deliverPrepared).toHaveBeenCalledTimes(mode === "prepared" ? 1 : 0);
      expect(deliver).toHaveBeenCalledTimes(mode === "legacy" ? 1 : 0);
    },
  );

  it("records channel transform suppression before TTS or visible fallback delivery", async () => {
    setNoAbort();
    const transport = vi.fn(async () => {});
    const transformReplyPayload = vi.fn(() => null);
    const dispatcher = createReplyDispatcher({ deliver: transport, transformReplyPayload });
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:123",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        await opts?.onBlockReply?.({ text: "private block" });
        return { text: "private reply" };
      },
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(result).toMatchObject({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
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
