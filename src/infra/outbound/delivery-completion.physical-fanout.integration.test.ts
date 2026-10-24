import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { chunkText } from "../../auto-reply/chunk.js";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import { getRestartRecoveryTerminalDeliveryEvidence as terminalEvidence } from "../../config/sessions/restart-recovery-state.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import {
  installRecoveryHooks,
  markFinal,
  registerMatrix,
  seedRecoverySession,
} from "./delivery-completion.shard-test-support.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import { loadPendingDeliveries } from "./delivery-queue.test-helpers.js";

const fixtures = installRecoveryHooks(false);
const deliverOutboundPayloads = fixtures.deliver;

it.each(
  (["live", "recovery"] as const).flatMap((mode) =>
    (["text", "media", "formatted"] as const).flatMap((transport) =>
      (
        [
          "complete",
          "suppressed-first",
          "suppressed-last",
          "unidentified-first",
          "unidentified-last",
        ] as const
      ).map((disposition) => ({ mode, transport, disposition })),
    ),
  ),
)(
  "requires every physical send in one logical final ($mode, $transport, $disposition)",
  async ({ mode, transport, disposition }) => {
    const tmpDir = fixtures.tmpDir();
    const { scope, context, entry } = await seedRecoverySession(tmpDir);
    // One logical final. Real core planning splits text or media into two sends.
    const payloads = [
      {
        text: "firstlast",
        ...(transport === "media"
          ? { mediaUrls: ["https://example.test/first.png", "https://example.test/second.png"] }
          : {}),
      },
    ];
    await markFinal(scope, entry, payloads, context);
    const completion = resolvePendingFinalDeliveryCompletion(payloads);
    assert(completion, "missing final custody");
    let physicalSends = 0;
    const send = vi.fn(async () => {
      const index = physicalSends++;
      const invalid = disposition.endsWith(index === 0 ? "first" : "last");
      return {
        channel: "matrix",
        messageId: invalid ? "" : index === 0 ? "first-id" : "second-id",
        ...(invalid && disposition.startsWith("suppressed")
          ? { outcome: "not_sent" as const }
          : {}),
      };
    });
    registerMatrix({
      ...matrixOutboundForQueueTest,
      chunker: chunkText,
      textChunkLimit: 5,
      ...(transport === "formatted"
        ? {
            sendFormattedText: async ({ onPlatformSendDispatch }) => {
              await onPlatformSendDispatch?.();
              return [await send(), await send()];
            },
          }
        : {}),
    });
    const progress: OutboundDeliveryResult[] = [];
    const runDelivery: typeof deliverOutboundPayloads = (params) =>
      deliverOutboundPayloads({
        ...params,
        deps: { matrix: send },
        onDeliveryResult: async (result) => {
          progress.push(result);
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
      await enqueueDeliveryOnce(params, completion.deliveryId, tmpDir);
      await recover();
    }
    const evidence = terminalEvidence(loadSessionEntry(scope), "source");
    if (disposition === "complete") {
      expect(evidence).toMatchObject({
        deliveryStatus: { status: "sent", resultCount: 2 },
        durableFinalReceipt: { platformMessageId: "second-id" },
      });
      expect(progress.map((result) => result.messageId)).toEqual(["first-id", "second-id"]);
    } else {
      expect(evidence).toBeUndefined();
      // Receipt refusal must not withhold valid physical progress or retry it.
      expect(progress.map((result) => result.messageId)).toEqual([
        disposition.endsWith("first") ? "second-id" : "first-id",
      ]);
    }
    await recover();
    expect(send).toHaveBeenCalledTimes(2);
    expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
  },
);
