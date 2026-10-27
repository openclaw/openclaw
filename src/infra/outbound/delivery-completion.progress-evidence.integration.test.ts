import { assert, expect, it, vi } from "vitest";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type {
  ChannelMessageSendResult,
  ChannelMessageSendTextContext as SendContext,
} from "../../channels/message/types.js";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import {
  installRecoveryHooks,
  markFinal,
  seedDeliverySession,
} from "./delivery-completion.shard-test-support.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import { loadPendingDeliveries } from "./delivery-queue.test-helpers.js";

type Receipt = ChannelMessageSendResult & { messageId: string };
function receipt(target?: string, threadId?: string): Receipt {
  return {
    messageId: "m",
    ...(target ? { target: { kind: "room", id: target } } : {}),
    receipt: {
      platformMessageIds: ["m"],
      parts: [{ platformMessageId: "m", kind: "text", index: 0 }],
      sentAt: 1,
      ...(threadId ? { threadId } : {}),
    },
  };
}

const context = { channel: "matrix", to: "!original:example", threadId: "thread" };
function placementCases(): Record<string, [boolean, Receipt?, Receipt?]> {
  const partThread = receipt();
  partThread.receipt.parts[0]!.threadId = "wrong";
  const nestedTarget = receipt();
  nestedTarget.receipt.raw = [{ roomId: "!other:example" }];
  const nestedThread = receipt();
  nestedThread.receipt.parts[0]!.raw = { ...receipt(undefined, "wrong"), messageId: "nested" };
  const aggregate = (
    results: Parameters<typeof createMessageReceiptFromOutboundResults>[0]["results"],
  ): Receipt => ({ ...receipt(), receipt: createMessageReceiptFromOutboundResults({ results }) });
  const unconfirmed = { messageId: "" },
    identified = { messageId: "m" };
  const nested = aggregate([unconfirmed, identified]);
  const mutatedRaw = aggregate([{ receipt: nested.receipt }, identified]);
  unconfirmed.messageId = "m";
  const incomplete = { receipt: aggregate([{ messageId: "" }, identified]).receipt };
  const metadata = receipt();
  metadata.receipt.raw = [{ roomId: context.to }];
  return {
    omitted: [true],
    enriched: [true, undefined, receipt(context.to, context.threadId)],
    normalized: [true, receipt("matrix:!original:example")],
    target: [false, receipt("!other:example")],
    "receipt-thread": [false, receipt(undefined, "wrong")],
    "part-thread": [false, partThread],
    "nested-target": [false, nestedTarget],
    "nested-thread": [false, nestedThread],
    "mutated-target": [false, receipt("!other:example")],
    "callback-mutation": [false, receipt("!other:example")],
    "aggregate-blank-first": [false, undefined, aggregate([{ messageId: "" }, identified])],
    "aggregate-blank-last": [false, undefined, aggregate([identified, { messageId: "" }])],
    "aggregate-nested": [false, undefined, aggregate([incomplete, identified])],
    "aggregate-mutated-raw": [false, undefined, mutatedRaw],
    "aggregate-not-sent": [false, undefined, aggregate([{ outcome: "not_sent" }, identified])],
    "aggregate-complete": [true, undefined, aggregate([{ messageId: "first" }, identified])],
    "aggregate-metadata": [true, undefined, aggregate([metadata])],
    "legacy-channel": [false],
    "legacy-expected": [true],
    "legacy-omitted": [true],
  };
}

const fixtures = installRecoveryHooks(false);
const { tmpDir, deliver: deliverOutboundPayloads } = fixtures;

it.each(
  (["live", "recovery"] as const).flatMap((mode) =>
    Object.entries(placementCases()).map(([name, [eligible]]) => [mode, name, eligible] as const),
  ),
)(
  "retains reported placement across same-ID final replacement (%s, %s)",
  async (mode, placement, eligible) => {
    const [, progress = receipt(), final = receipt()] = placementCases()[placement]!;
    const { scope, entry } = await seedDeliverySession(tmpDir());
    const payloads = [{ text: "final" }];
    await markFinal(scope, entry, payloads, context);
    const completion = resolvePendingFinalDeliveryCompletion(payloads);
    assert(completion, "missing final custody");
    const committed = vi.fn();
    const send = vi.fn(async (ctx: SendContext) => {
      await ctx.onDeliveryResult?.(progress);
      if (placement === "mutated-target") {
        progress.target!.id = context.to;
      }
      return final;
    });
    const plugin = createOutboundTestPlugin({
      id: "matrix",
      outbound: matrixOutboundForQueueTest,
      messaging: { normalizeTarget: (raw) => raw.replace(/^matrix:/, "") },
    });
    const legacy = placement.startsWith("legacy-");
    const legacySend = vi.fn(async (ctx: ChannelOutboundContext) => {
      const result: OutboundDeliveryResult = {
        ...receipt(),
        channel: placement === "legacy-channel" ? "discord" : "matrix",
      };
      if (placement === "legacy-omitted") {
        delete result.receipt;
      }
      await ctx.onDeliveryResult?.(result);
      return { ...receipt(), channel: "matrix" };
    });
    if (legacy) {
      plugin.outbound = { ...matrixOutboundForQueueTest, sendText: legacySend };
    } else {
      plugin.message = {
        send: { text: send, lifecycle: { afterCommit: committed } },
        durableFinal: { capabilities: { text: true, thread: true, afterCommit: true } },
      };
    }
    setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
    const seen: string[] = [];
    const runDelivery: typeof deliverOutboundPayloads = (params) =>
      deliverOutboundPayloads({
        ...params,
        onDeliveryResult: async (result) => {
          seen.push(result.messageId);
          if (placement === "legacy-channel") {
            result.channel = "matrix";
          }
          if (placement === "callback-mutation" && result.target) {
            result.target.id = context.to;
          }
          await params.onDeliveryResult?.(result);
        },
      });
    const recover = () => fixtures.recover(runDelivery);
    const params = {
      cfg: {},
      ...context,
      payloads,
      deliveryCompletion: completion,
      deliveryIntentId: completion.deliveryId,
      queuePolicy: "required" as const,
    };
    if (mode === "live") {
      await runDelivery(params);
    } else {
      await enqueueDeliveryOnce(params, completion.deliveryId, tmpDir());
      await recover();
    }
    const receipt = loadSessionEntry(scope)?.pendingFinalDelivery?.deliveries?.[0]?.receipt;
    if (eligible) {
      expect(receipt).toMatchObject({
        resultCount: placement === "aggregate-complete" ? 2 : 1,
        platformMessageId: placement === "aggregate-complete" ? "first" : "m",
      });
    } else {
      expect(receipt).toBeUndefined();
    }
    expect(seen).toEqual(["m"]);
    expect(committed).toHaveBeenCalledTimes(legacy ? 0 : 1);
    await recover();
    expect(send).toHaveBeenCalledTimes(legacy ? 0 : 1);
    expect(legacySend).toHaveBeenCalledTimes(legacy ? 1 : 0);
    expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
  },
);
