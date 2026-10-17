import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
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
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { attachReplyDispatchUndeliveredFallback } from "./reply-dispatcher.js";

const deliver = vi.hoisted(() => vi.fn());

vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: deliver,
  deliverOutboundPayloadsInternal: deliver,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliver,
  deliverOutboundPayloadsInternal: deliver,
}));

const { routeReply: routeReplyRuntime } = await import("./route-reply.js");
type RouteReplyParams = Parameters<typeof routeReplyRuntime>[0];
const routeReply = (
  params: Omit<RouteReplyParams, "replyKind" | "channel" | "to" | "cfg"> &
    Partial<Pick<RouteReplyParams, "replyKind" | "channel" | "to" | "cfg">>,
) =>
  routeReplyRuntime({ replyKind: "final", channel: "telegram", to: "chat-1", cfg: {}, ...params });

function createChannelPlugin(): ChannelPlugin {
  return createChannelTestPluginBase({
    id: "telegram",
    label: "Telegram",
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
  });
}

function installPlugin(plugin = createChannelPlugin()) {
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
}

function suppressDelivery(reason: string) {
  deliver.mockImplementationOnce(
    async ({
      onPayloadDeliveryOutcome,
    }: {
      onPayloadDeliveryOutcome?: (outcome: unknown) => void;
    }) => {
      onPayloadDeliveryOutcome?.({ index: 0, status: "suppressed", reason });
      return [];
    },
  );
}

describe("routeReply delivery result", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    installPlugin();
    deliver.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it.each([
    ["channel_transform", true, 0, "deliveredNotVisible", false],
    ["invisible", true, 2, "delivered", true],
    ["not-dispatched", true, 2, "delivered", true],
    ["not-dispatched", false, 1, "failedBeforeSend", false],
    ["unknown", true, 1, "failedAfterSend", true],
    ["no-identity", true, 1, "failedAfterSend", true],
    ["partial", true, 1, "delivered", true],
  ] as const)(
    "settles routed %s with caption fallback=%s",
    async (outcome, fallback, calls, count, visible) => {
      const custody =
        outcome === "partial"
          ? {
              sessionKey: "agent:main:background-delivery",
              storePath: path.join(tempDirs.make("partial-background-delivery-"), "sessions.json"),
              sessionId: "partial-session",
              intentId: "partial-intent",
              deliveryId: "partial-delivery",
            }
          : undefined;
      if (custody) {
        await replaceSessionEntry(custody, {
          sessionId: custody.sessionId,
          updatedAt: Date.now(),
          pendingFinalDelivery: {
            kind: "replayable",
            text: "voice caption",
            createdAt: Date.now(),
            intentId: custody.intentId,
            deliveries: [{ id: custody.deliveryId, state: "prepared" }],
          },
        });
      }
      if (outcome === "channel_transform") {
        const plugin = createChannelPlugin();
        plugin.messaging = {
          transformReplyPayload: ({ payload }) => (payload.mediaUrl ? null : payload),
        };
        installPlugin(plugin);
      }
      deliver.mockResolvedValue([{ channel: "telegram", messageId: "caption-sent" }]);
      const notDispatched = new PlatformMessageNotDispatchedError("before platform dispatch", {
        cause: new Error("offline"),
      });
      if (outcome === "invisible") {
        deliver.mockResolvedValueOnce([]);
      } else if (outcome === "no-identity") {
        suppressDelivery("adapter_returned_no_identity");
      } else if (outcome === "not-dispatched") {
        deliver.mockRejectedValueOnce(notDispatched);
      } else if (outcome === "unknown") {
        deliver.mockRejectedValueOnce(new Error("transport outcome unknown"));
      } else if (outcome === "partial") {
        deliver.mockRejectedValueOnce(
          new OutboundDeliveryError("later payload failed", {
            cause: notDispatched,
            results: [{ channel: "telegram", messageId: "already-sent" }],
            stage: "platform_send",
          }),
        );
      }
      const closeStore = async () => {
        if (!custody) {
          return;
        }
        await closeOpenClawAgentDatabasesAsync(path.dirname(custody.storePath));
        closeOpenClawAgentDatabasesForTest(path.dirname(custody.storePath));
      };
      let deliveryError: string | undefined;
      try {
        const cfg = custody ? { session: { store: custody.storePath } } : {};
        const result = await dispatchInboundMessageWithRoutedChannelDispatcher({
          cfg,
          ctx: {
            Body: "Continue",
            AgentId: "main",
            SessionKey: "agent:main:background-delivery",
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
                channel: "telegram",
                to: "original",
                agentId: "main",
                sessionKey: "agent:main:background-delivery",
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
                ...(sent.ambiguous ? { ambiguous: true } : {}),
                ...(sent.suppressed ? { suppression: { reason: sent.reason } } : {}),
              };
            },
          },
          dispatchReplyFromConfig: async ({ dispatcher }) => {
            const payload = {
              text: "voice caption",
              mediaUrl: "https://example.com/voice.opus",
              audioAsVoice: true,
            };
            if (custody) {
              setReplyPayloadMetadata(payload, { pendingFinalDeliveryCompletion: custody });
            }
            if (fallback) {
              attachReplyDispatchUndeliveredFallback(
                payload,
                buildCaptionedFinalTextFallback(payload),
              );
            }
            dispatcher.sendFinalReply(payload);
            return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
          },
        });
        expect(result.settledReceipt).toMatchObject({
          counts: { final: { [count]: 1 } },
          anyVisibleDelivered: visible,
        });
        expect(deliver).toHaveBeenCalledTimes(calls);
        if (custody) {
          expect(deliveryError).toContain("later payload failed");
          await closeStore();
          expect(loadSessionEntry(custody)?.pendingFinalDelivery?.deliveries).toEqual([
            { id: custody.deliveryId, state: "delivered" },
          ]);
        }
      } finally {
        await closeStore();
      }
    },
  );

  it.each([
    "cancelled_by_message_sending_hook",
    "empty_after_message_sending_hook",
    "adapter_returned_no_send",
  ] as const)(
    "returns intentional suppression reason %s without claiming delivery",
    async (reason) => {
      suppressDelivery(reason);
      const res = await routeReply({ payload: { text: "hello" } });

      expect(res).toEqual({
        ok: true,
        delivered: false,
        suppressed: true,
        reason,
      });
    },
  );

  it("treats a send without adapter identity as ambiguous and non-retryable", async () => {
    mocks.deliverOutboundPayloads.mockImplementationOnce(
      async ({
        onPayloadDeliveryOutcome,
      }: {
        onPayloadDeliveryOutcome?: (outcome: unknown) => void;
      }) => {
        onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "adapter_returned_no_identity",
        });
        return [];
      },
    );

    const res = await routeReply({
      payload: { text: "hello" },
      channel: "telegram",
      to: "chat-1",
      cfg: {} as never,
    });

    expect(res).toEqual({
      ok: true,
      delivered: false,
      ambiguous: true,
      reason: "adapter_returned_no_identity",
    });
  });

  it("preserves session writer authority through route normalization", async () => {
    deliver.mockResolvedValueOnce([{ channel: "telegram", messageId: "message-1" }]);
    const authority = {
      expectedLifecycleRevision: "revision-a",
      expectedSessionId: "session-1",
      expectedWriterRunId: "run-a",
      sessionKey: "agent:main:telegram:direct:1",
      storePath: "/tmp/sessions.json",
    };

    await routeReply({
      payload: setReplyPayloadMetadata(
        { text: "hello" },
        { sessionWriterDeliveryAuthority: authority },
      ),
    });

    const call = deliver.mock.calls[0];
    if (!call) {
      throw new Error("expected routed delivery");
    }
    const sentPayload = (call[0] as { payloads: object[] }).payloads[0]!;
    expect(getReplyPayloadMetadata(sentPayload)?.sessionWriterDeliveryAuthority).toEqual(authority);
  });

  it.each([
    ["a trailing suppression sentinel", { channel: "telegram", messageId: "suppressed" }],
    ["a trailing unknown sentinel", { channel: "telegram", messageId: "unknown" }],
    ["a trailing ok sentinel", { channel: "telegram", messageId: "ok" }],
    ["a trailing no-id receipt", { channel: "telegram", messageId: "" }],
  ])("preserves an earlier editable message id after %s", async (_label, trailingResult) => {
    const cause = new Error("network reset");
    const failure = new OutboundDeliveryError("network reset", {
      cause,
      results: [{ channel: "telegram", messageId: "msg-1" }, trailingResult],
      stage: "platform_send",
    });
    deliver.mockRejectedValueOnce(failure);

    const res = await routeReply({ payload: { text: "hello" } });

    expect(res).toEqual({
      ok: false,
      delivered: true,
      error: "Failed to route reply to telegram: network reset",
      cause: failure,
      messageId: "msg-1",
    });
    expect(res.cause).toBe(failure);
  });

  it.each([
    ["skipped", false, undefined],
    ["suppressed", false, undefined],
    ["unknown", true, undefined],
    ["ok", true, undefined],
  ] as const)(
    "reports message id %s visibility as %s",
    async (messageId, delivered, returnedId) => {
      mocks.deliverOutboundPayloads.mockResolvedValueOnce([{ channel: "telegram", messageId }]);

      const res = await routeReply({
        payload: { text: "hello" },
        channel: "telegram",
        to: "chat-1",
        cfg: {} as never,
      });

      expect(res).toEqual({
        ok: true,
        delivered,
        ...(returnedId === undefined ? {} : { messageId: returnedId }),
      });
    },
  );
});
