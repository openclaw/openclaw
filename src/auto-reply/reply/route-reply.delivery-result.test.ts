// Tests routeReply delivery evidence and editable message identity.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
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
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
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

function suppressDelivery(reason: string) {
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
}

function createChannelPlugin(): ChannelPlugin {
  return createChannelTestPluginBase({
    id: "telegram",
    label: "Telegram",
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
  });
}

describe("routeReply delivery result", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createChannelPlugin(),
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
    mocks.deliverOutboundPayloads.mockResolvedValue([
      { channel: "telegram", messageId: "caption-sent" },
    ]);
    const notDispatched = new PlatformMessageNotDispatchedError("before platform dispatch", {
      cause: new Error("offline"),
    });
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(
      new OutboundDeliveryError("later payload failed", {
        cause: notDispatched,
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
      suppressDelivery(reason);
      expect(await routeReply()).toEqual({ ok: true, delivered: false, ...outcome });
    },
  );

  it("preserves session writer authority through route normalization", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValueOnce([
      { channel: "telegram", messageId: "message-1" },
    ]);
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

    const call = mocks.deliverOutboundPayloads.mock.calls[0];
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
  });

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
