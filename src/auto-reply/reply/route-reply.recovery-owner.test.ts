import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { drainMatrixReconnect } from "../../infra/outbound/deliver.queue-integration.test-support.js";
import { loadPendingDeliveries } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { buildCaptionedFinalTextFallback } from "../../tts/captioned-final.js";
import { dispatchInboundMessageWithRoutedChannelDispatcher } from "../dispatch.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { pendingFinalSessionEntry } from "./dispatch-from-config.session-fixtures.test-support.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import { attachReplyDispatchUndeliveredFallback } from "./reply-dispatcher.js";
import { installRouteReplyFixture } from "./route-reply.fixture.test-support.js";
import { routeReply } from "./route-reply.js";

describe("caption fallback recovery ownership", () => {
  const fixtures = installRouteReplyFixture(true);

  it.each([false, true])(
    "keeps retained no-send as the only retry owner with custody=%s",
    async (withCustody) => {
      const custody = {
        storePath: path.join(fixtures.tmpDir(), "sessions.json"),
        sessionKey: "agent:main:recovery-owner",
        sessionId: "owner-session",
        intentId: "owner-intent",
        deliveryId: "owner-delivery",
      };
      const expectCustody = (state: "queued" | "delivered") => {
        if (withCustody) {
          expect(
            (loadSessionEntry(custody) as InternalSessionEntry)?.pendingFinalDelivery?.deliveries,
          ).toEqual([{ id: custody.deliveryId, state }]);
        }
      };
      if (withCustody) {
        await replaceSessionEntry(
          custody,
          pendingFinalSessionEntry(custody, "The completed answer"),
        );
      }
      let ledger: ReturnType<typeof createReplyTurnLedger> | undefined;
      let settled = false;
      const visible: string[] = [];
      let mediaAttempts = 0;
      const outbound: ChannelOutboundAdapter = {
        deliveryMode: "direct",
        sendText: async ({ onPlatformSendDispatch }) => {
          await onPlatformSendDispatch?.();
          visible.push("caption");
          return { channel: "matrix", messageId: "caption-sent" };
        },
        sendMedia: async ({ onPlatformSendDispatch }) => {
          await onPlatformSendDispatch?.();
          if (mediaAttempts++ === 0) {
            throw new PlatformMessageNotDispatchedError("media was not dispatched", {
              cause: new Error("connection unavailable"),
            });
          }
          visible.push("media");
          return { channel: "matrix", messageId: "media-recovered" };
        },
      };
      fixtures.register(outbound);
      await dispatchInboundMessageWithRoutedChannelDispatcher({
        cfg: {},
        ctx: {
          Body: "Continue",
          AgentId: "main",
          SessionKey: custody.sessionKey,
          Provider: "matrix",
          Surface: "matrix",
          OriginatingChannel: "matrix",
          OriginatingTo: "!room:example",
        },
        dispatcherOptions: {
          propagateRetryableNoSendFailure: true,
          beforeDeliver: (payload) => {
            if (payload.text === "preflight") {
              throw new PlatformMessageNotDispatchedError("preflight did not dispatch", {
                cause: new Error("offline"),
              });
            }
            return payload;
          },
          deliver: async (payload, info) => {
            const sent = await routeReply({
              cfg: {},
              payload,
              channel: "matrix",
              to: "!room:example",
              agentId: "main",
              sessionKey: custody.sessionKey,
              replyKind: info.kind,
              mirror: false,
            });
            if (!sent.ok) {
              throw new Error(sent.error, { cause: sent.cause });
            }
            return {
              visibleReplySent: sent.delivered,
              ...(sent.ambiguous ? { ambiguous: true } : {}),
              ...(sent.suppressed ? { suppression: { reason: sent.reason } } : {}),
            };
          },
        },
        dispatchReplyFromConfig: async ({ dispatcher }) => {
          const payload = {
            text: "The completed answer",
            mediaUrl: "https://example.com/answer.ogg",
            audioAsVoice: true,
          };
          if (withCustody) {
            setReplyPayloadMetadata(payload, { pendingFinalDeliveryCompletion: custody });
          }
          attachReplyDispatchUndeliveredFallback(payload, buildCaptionedFinalTextFallback(payload));
          ledger = createReplyTurnLedger(dispatcher);
          if (!withCustody) {
            ledger.sendQueued("tool", { text: "preflight" });
          }
          ledger.sendQueued("final", payload);
          if (withCustody) {
            ledger.sendQueued("tool", { text: "preflight" });
          }
          await ledger.settleQueued();
          settled = true;
          return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
        },
      });
      expect(visible).toEqual([]);
      expect(settled).toBe(true);
      expect(ledger?.mayHaveDelivered()).toBe(false);
      expect(ledger?.hasObservedDelivery()).toBe(false);
      expect(ledger?.canAttemptFallback()).toBe(false);
      expectCustody("queued");
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(1);

      await drainMatrixReconnect({ deliver: deliverOutboundPayloads, stateDir: fixtures.tmpDir() });

      expect(visible).toEqual(["media"]);
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
      expectCustody("delivered");
    },
  );
});
