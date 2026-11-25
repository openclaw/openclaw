import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { buildCaptionedFinalTextFallback } from "../../tts/captioned-final.js";
import { dispatchInboundMessageWithRoutedChannelDispatcher } from "../dispatch.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { pendingFinalSessionEntry } from "./dispatch-from-config.session-fixtures.test-support.js";
import { attachReplyDispatchUndeliveredFallback } from "./reply-dispatcher.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
}));

vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

const { routeReply: routeReplyRuntime } = await import("./route-reply.js");
type RouteReplyParams = Parameters<typeof routeReplyRuntime>[0];
const routeReply = (params: Partial<RouteReplyParams> = {}) =>
  routeReplyRuntime({
    replyKind: "final",
    payload: { text: "hello" },
    channel: "telegram",
    to: "chat-1",
    cfg: {},
    ...params,
  });

describe("routeReply delivery result", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createChannelTestPluginBase({
            id: "telegram",
            label: "Telegram",
            config: { listAccountIds: () => [], resolveAccount: () => ({}) },
          }),
          source: "test",
        },
      ]),
    );
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("settles partial routed delivery without replaying its caption", async () => {
    const custody = {
      sessionKey: "agent:main:background-delivery",
      storePath: path.join(tempDirs.make("partial-background-delivery-"), "sessions.json"),
      sessionId: "partial-session",
      intentId: "partial-intent",
      deliveryId: "partial-delivery",
    };
    await replaceSessionEntry(custody, pendingFinalSessionEntry(custody, "voice caption"));
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(
      new OutboundDeliveryError("later payload failed", {
        cause: new PlatformMessageNotDispatchedError("before platform dispatch", {
          cause: new Error("offline"),
        }),
        results: [{ channel: "telegram", messageId: "already-sent" }],
        stage: "platform_send",
      }),
    );
    let deliveryError: string | undefined;
    try {
      const cfg = { session: { store: custody.storePath } };
      const result = await dispatchInboundMessageWithRoutedChannelDispatcher({
        cfg,
        ctx: {
          Body: "Continue",
          AgentId: "main",
          SessionKey: custody.sessionKey,
          Provider: "telegram",
          Surface: "telegram",
          OriginatingChannel: "telegram",
          OriginatingTo: "original",
        },
        dispatcherOptions: {
          deliver: async (payload, info) => {
            const sent = await routeReply({
              cfg,
              payload,
              to: "original",
              agentId: "main",
              sessionKey: custody.sessionKey,
              replyKind: info.kind,
              mirror: false,
            });
            if (!sent.ok) {
              if (!sent.delivered || sent.ambiguous) {
                throw new Error(sent.error, { cause: sent.cause });
              }
              deliveryError = sent.error;
            }
            return {
              visibleReplySent: sent.delivered,
            };
          },
        },
        dispatchReplyFromConfig: async ({ dispatcher }) => {
          const payload = {
            text: "voice caption",
            mediaUrl: "https://example.com/voice.opus",
            audioAsVoice: true,
          };
          setReplyPayloadMetadata(payload, { pendingFinalDeliveryCompletion: custody });
          attachReplyDispatchUndeliveredFallback(payload, buildCaptionedFinalTextFallback(payload));
          dispatcher.sendFinalReply(payload);
          return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
        },
      });
      expect(result.settledReceipt).toMatchObject({
        counts: { final: { delivered: 1 } },
        anyVisibleDelivered: true,
      });
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
      expect(deliveryError).toContain("later payload failed");
      await closeOpenClawAgentDatabasesAsync(path.dirname(custody.storePath));
      closeOpenClawAgentDatabasesForTest(path.dirname(custody.storePath));
      expect(
        (loadSessionEntry(custody) as InternalSessionEntry)?.pendingFinalDelivery?.deliveries,
      ).toEqual([{ id: custody.deliveryId, state: "delivered" }]);
    } finally {
      await closeOpenClawAgentDatabasesAsync(path.dirname(custody.storePath));
      closeOpenClawAgentDatabasesForTest(path.dirname(custody.storePath));
    }
  });

  it.each([
    ["cancelled_by_message_sending_hook", { suppressed: true }],
    ["empty_after_message_sending_hook", { suppressed: true }],
    ["adapter_returned_no_send", { suppressed: true }],
    ["adapter_returned_no_identity", { ambiguous: true }],
  ] as const)(
    "projects suppression or ambiguity for %s without claiming delivery",
    async (reason, outcome) => {
      mocks.deliverOutboundPayloads.mockImplementationOnce(
        async ({
          onPayloadDeliveryOutcome,
        }: {
          onPayloadDeliveryOutcome?: (outcome: unknown) => void;
        }) => {
          onPayloadDeliveryOutcome?.({ index: 0, status: "suppressed", reason });
          return [];
        },
      );
      expect(await routeReply()).toEqual({ ok: true, delivered: false, ...outcome });
    },
  );

  it.each(["suppressed", "unknown", "ok", ""])(
    "preserves an earlier editable message id after %s",
    async (messageId) => {
      const failure = new OutboundDeliveryError("network reset", {
        cause: new Error("network reset"),
        results: ["msg-1", messageId].map((id) => ({ channel: "telegram", messageId: id })),
        stage: "platform_send",
      });
      mocks.deliverOutboundPayloads.mockRejectedValueOnce(failure);

      const res = await routeReply();

      expect(res).toEqual({
        ok: false,
        delivered: true,
        error: "Failed to route reply to telegram: network reset",
        cause: failure,
        messageId: "msg-1",
      });
      expect(res.cause).toBe(failure);
    },
  );

  it.each([
    ["skipped", false],
    ["suppressed", false],
    ["unknown", true],
    ["ok", true],
  ] as const)("reports message id %s visibility as %s", async (messageId, delivered) => {
    mocks.deliverOutboundPayloads.mockResolvedValueOnce([{ channel: "telegram", messageId }]);

    expect(await routeReply()).toEqual({ ok: true, delivered });
  });
});
