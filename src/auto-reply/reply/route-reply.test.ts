// Tests routeReply delivery decisions across channels and fallback paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelMessagingAdapter,
  ChannelPlugin,
  ChannelThreadingAdapter,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { isRetryableDeliveryNotSentError } from "../../infra/delivery-recovery.shared.js";
import {
  OutboundDeliveryError,
  type OutboundPayloadDeliveryOutcome,
} from "../../infra/outbound/deliver-types.js";
import type { DeliverOutboundPayloadsParams } from "../../infra/outbound/deliver.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { resolveRoutedReplyDeliveryOutcome } from "./reply-dispatch-outcome.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  hookRunner: undefined as
    | {
        hasHooks: ReturnType<typeof vi.fn>;
        runMessageSending: ReturnType<typeof vi.fn>;
        runReplyPayloadSending: ReturnType<typeof vi.fn>;
      }
    | undefined,
}));

vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocks.hookRunner,
}));

const { routeReply: routeReplyRuntime } = await import("./route-reply.js");
type RouteReplyParams = Parameters<typeof routeReplyRuntime>[0];
const routeReply = (
  params: Omit<RouteReplyParams, "replyKind"> & { replyKind?: RouteReplyParams["replyKind"] },
) => routeReplyRuntime({ replyKind: "final", ...params });

const slackMessaging: ChannelMessagingAdapter = {
  hasStructuredReplyPayload: ({ payload }) => {
    const blocks = (payload.channelData?.slack as { blocks?: unknown } | undefined)?.blocks;
    if (typeof blocks === "string") {
      return blocks.trim().length > 0;
    }
    return Array.isArray(blocks) && blocks.length > 0;
  },
};

const slackThreading: ChannelThreadingAdapter = {
  resolveReplyTransport: ({ threadId, replyToId, replyDelivery }) => {
    const resolvedReplyToId =
      resolveSlackThreadTsCandidate(replyDelivery?.replyToMode === "off" ? undefined : replyToId) ??
      resolveSlackThreadTsCandidate(threadId);
    return {
      replyToId:
        replyDelivery?.replyToMode === "off" && !resolvedReplyToId ? null : resolvedReplyToId,
      threadId: null,
    };
  },
};

function resolveSlackThreadTsCandidate(value?: string | number | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return /^\d+\.\d+$/.test(normalized) ? normalized : undefined;
}

function createChannelPlugin(
  id: ChannelPlugin["id"],
  options: {
    messaging?: ChannelMessagingAdapter;
    threading?: ChannelThreadingAdapter;
    label?: string;
  } = {},
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id,
      label: options.label ?? String(id),
      config: { listAccountIds: () => [], resolveAccount: () => ({}) },
    }),
    ...(options.messaging ? { messaging: options.messaging } : {}),
    ...(options.threading ? { threading: options.threading } : {}),
  };
}

function lastDelivery() {
  const call = mocks.deliverOutboundPayloads.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected outbound delivery call");
  }
  const delivery = call[0];
  if (!delivery || typeof delivery !== "object") {
    throw new Error("expected outbound delivery");
  }
  return delivery as Record<string, unknown>;
}

function expectLastDeliveryFields(fields: Record<string, unknown>) {
  const delivery = lastDelivery();
  for (const [key, expected] of Object.entries(fields)) {
    expect(delivery[key]).toEqual(expected);
  }
}

function lastDeliveryPayload(index = 0): Record<string, unknown> {
  const payloads = lastDelivery().payloads;
  expect(Array.isArray(payloads)).toBe(true);
  const payload = (payloads as unknown[])[index];
  if (!payload || typeof payload !== "object") {
    throw new Error(`expected delivery payload ${index}`);
  }
  return payload as Record<string, unknown>;
}

function routeTestReply(
  overrides: Omit<Parameters<typeof routeReply>[0], "cfg"> &
    Partial<Pick<Parameters<typeof routeReply>[0], "cfg">>,
) {
  return routeReply({ cfg: {} as never, ...overrides });
}

async function expectSlackNoDelivery(
  payload: Parameters<typeof routeReply>[0]["payload"],
  overrides: Partial<Parameters<typeof routeReply>[0]> = {},
) {
  mocks.deliverOutboundPayloads.mockClear();
  const res = await routeTestReply({
    payload,
    channel: "slack",
    to: "channel:C123",
    ...overrides,
  });
  expect(res.ok).toBe(true);
  expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  return res;
}

describe("routeReply", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: createChannelPlugin("slack", {
            label: "Slack",
            messaging: slackMessaging,
            threading: slackThreading,
          }),
          source: "test",
        },
        {
          pluginId: "telegram",
          plugin: createChannelPlugin("telegram", { label: "Telegram" }),
          source: "test",
        },
      ]),
    );
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
    mocks.hookRunner = undefined;
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it.each([
    { channel: "slack", aborted: true, error: "Reply routing aborted" },
    {
      channel: "webchat",
      aborted: false,
      error: "Webchat routing not supported for queued replies",
    },
    { channel: "", aborted: false, error: "Unknown channel: " },
  ] as const)("records pre-I/O no-send for $error", async ({ channel, aborted, error }) => {
    const controller = new AbortController();
    if (aborted) {
      controller.abort();
    }
    const res = await routeTestReply({
      payload: { text: "hi" },
      channel,
      to: "channel:C123",
      abortSignal: controller.signal,
    });
    expect(res).toMatchObject({ ok: false, delivered: false, error });
    expect(isRetryableDeliveryNotSentError(res.cause)).toBe(true);
    expect(resolveRoutedReplyDeliveryOutcome(res)).toBe("failed-before-deliver");
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("no-ops on empty payload", async () => {
    await expectSlackNoDelivery({});
  });

  it("suppresses reasoning payloads", async () => {
    await expect(expectSlackNoDelivery({ text: "step", isReasoning: true })).resolves.toMatchObject(
      {
        delivered: false,
        suppressed: true,
        reason: "reasoning_payload_not_external",
      },
    );
  });

  it("drops silent token payloads", async () => {
    await expectSlackNoDelivery({ text: SILENT_REPLY_TOKEN });
  });

  it("records a channel transform veto before transport or mirroring", async () => {
    const messaging = {
      transformReplyPayload: vi.fn(function (this: unknown) {
        expect(this).toBe(messaging);
        return null;
      }),
    } satisfies ChannelMessagingAdapter;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: createChannelPlugin("slack", { messaging, threading: slackThreading }),
          source: "test",
        },
      ]),
    );

    const result = await routeTestReply({
      payload: { text: "private reply" },
      channel: "slack",
      to: "channel:C123",
      sessionKey: "agent:main:test",
    });

    expect(result).toEqual({
      ok: true,
      delivered: false,
      suppressed: true,
      reason: "channel_transform",
    });
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does not drop payloads that merely start with the silent token", async () => {
    const res = await routeTestReply({
      payload: { text: `${SILENT_REPLY_TOKEN} -- (why am I here?)` },
      channel: "slack",
      to: "channel:C123",
    });
    expect(res.ok).toBe(true);
    expectLastDeliveryFields({
      channel: "slack",
      to: "channel:C123",
    });
    expect(lastDeliveryPayload().text).toBe(`${SILENT_REPLY_TOKEN} -- (why am I here?)`);
  });

  it("passes replayable reply payload hook context to routed delivery", async () => {
    const res = await routeTestReply({
      payload: { text: "hello" },
      channel: "telegram",
      to: "chat-1",
      accountId: "acct-1",
      sessionKey: "agent:main:test",
      requesterSenderId: "sender-1",
      replyKind: "block",
      runId: "run-1",
      deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:item-1",
    });

    expect(res).toMatchObject({ ok: true, delivered: false });
    expect(res.queueCustody).toBeUndefined();
    expect(lastDeliveryPayload()).toMatchObject({ text: "hello" });
    expect(lastDelivery().replyPayloadSendingHook).toMatchObject({
      kind: "block",
      channel: "telegram",
      sessionKey: "agent:main:test",
      runId: "run-1",
      context: {
        channelId: "telegram",
        accountId: "acct-1",
        conversationId: "chat-1",
        sessionKey: "agent:main:test",
        senderId: "sender-1",
        runId: "run-1",
      },
    });
    expect(lastDelivery()).not.toHaveProperty("skipMessageSendingHooks");
    expectLastDeliveryFields({
      queuePolicy: "required",
      deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:item-1",
      reusePendingDeliveryIntent: true,
      completionRetention: {
        idPrefix: "block-reply:v1:",
        maxAgeMs: 24 * 60 * 60_000,
        maxEntries: 2_000,
      },
    });
  });

  it("keeps fresh payload reply mode for the same destination policy route", async () => {
    const payload = setReplyPayloadMetadata(
      { text: "hello", replyToId: "999.000" },
      {
        replyDelivery: {
          chatType: "channel",
          replyToMode: "all",
        },
        replyDeliverySource: {
          channel: "slack",
          accountId: "primary",
        },
      },
    );

    const res = await routeTestReply({
      payload,
      channel: "slack",
      to: "channel:C123",
      accountId: "primary",
      replyDelivery: {
        chatType: "channel",
        replyToMode: "off",
      },
    });

    expect(res.ok).toBe(true);
    expectLastDeliveryFields({
      replyToId: "999.000",
      threadId: null,
    });
    expect(lastDeliveryPayload().replyToId).toBe("999.000");
  });

  it("uses destination reply policy when payload policy came from another route", async () => {
    const payload = setReplyPayloadMetadata(
      { text: "hello", replyToId: "999.000" },
      {
        replyDelivery: {
          chatType: "direct",
          replyToMode: "all",
        },
        replyDeliverySource: {
          channel: "webchat",
        },
      },
    );

    const res = await routeTestReply({
      payload,
      channel: "slack",
      to: "channel:C123",
      replyDelivery: {
        chatType: "channel",
        replyToMode: "off",
      },
    });

    expect(res.ok).toBe(true);
    expectLastDeliveryFields({
      replyToId: null,
      threadId: null,
    });
    expect(lastDeliveryPayload().replyToId).toBeUndefined();
  });

  it("suppresses routed delivery when reply payload hooks empty the payload", async () => {
    mocks.deliverOutboundPayloads.mockImplementationOnce(
      async ({
        onPayloadDeliveryOutcome,
      }: {
        onPayloadDeliveryOutcome?: (outcome: unknown) => void;
      }) => {
        onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "empty_after_reply_payload_sending_hook",
        });
        return [];
      },
    );

    const res = await routeTestReply({
      payload: { text: "hello" },
      channel: "telegram",
      to: "chat-1",
    });

    expect(res).toEqual({
      ok: true,
      delivered: false,
      suppressed: true,
      reason: "empty_after_reply_payload_sending_hook",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("uses the policy session's direct conversation type over a group routing hint", async () => {
    const res = await routeTestReply({
      payload: { text: "native command response" },
      channel: "slack",
      to: "channel:C123",
      sessionKey: "agent:main:main",
      policySessionKey: "agent:main:slack:direct:U123",
      isGroup: true,
    });

    expect(res.ok).toBe(true);
    expect(lastDeliveryPayload().text).toBe("native command response");
    const session = lastDelivery().session as Record<string, unknown>;
    expect(session.key).toBe("agent:main:main");
    expect(session.policyKey).toBe("agent:main:slack:direct:U123");
    expect(session.conversationType).toBe("direct");
  });

  it("interpolates responsePrefix from the routed channel and account", async () => {
    const cfg = {
      channels: {
        slack: {
          responsePrefix: "[slack]",
          accounts: {
            support: { responsePrefix: "[{modelFull} think:{thinkingLevel}]" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await routeTestReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      accountId: "support",
      sessionKey: "agent:main:main",
      responsePrefixContext: {
        modelFull: "anthropic/claude-opus-4-6",
        thinkingLevel: "high",
      },
      cfg,
    });
    expect(lastDeliveryPayload().text).toBe("[anthropic/claude-opus-4-6 think:high] hi");
  });

  it("does not bypass the empty-reply guard for invalid Slack blocks", async () => {
    await expectSlackNoDelivery({
      text: " ",
      channelData: {
        slack: {
          blocks: " ",
        },
      },
    });
  });

  it("formats BTW replies prominently on routed sends", async () => {
    await routeTestReply({
      payload: { text: "323", btw: { question: "what is 17 * 19?" } },
      channel: "slack",
      to: "channel:C123",
    });
    expectLastDeliveryFields({
      channel: "slack",
    });
    expect(lastDeliveryPayload().text).toBe("BTW\nQuestion: what is 17 * 19?\n\n323");
  });

  it("preserves audioAsVoice on routed outbound payloads", async () => {
    await routeTestReply({
      payload: { text: "voice caption", mediaUrl: "file:///tmp/clip.mp3", audioAsVoice: true },
      channel: "slack",
      to: "channel:C123",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectLastDeliveryFields({
      channel: "slack",
      to: "channel:C123",
    });
    expect(lastDeliveryPayload().text).toBe("voice caption");
    expect(lastDeliveryPayload().mediaUrl).toBe("file:///tmp/clip.mp3");
    expect(lastDeliveryPayload().audioAsVoice).toBe(true);
  });

  it("preserves multiple mediaUrls as a single outbound payload", async () => {
    await routeTestReply({
      payload: { text: "caption", mediaUrls: ["a", "b"] },
      channel: "slack",
      to: "channel:C123",
    });
    expectLastDeliveryFields({
      channel: "slack",
    });
    expect(lastDeliveryPayload().text).toBe("caption");
    expect(lastDeliveryPayload().mediaUrls).toEqual(["a", "b"]);
  });

  it.each([{ sessionKey: "global", expectedAgentId: "finance" }])(
    "preserves delivery and mirror ownership for $sessionKey",
    async ({ sessionKey, expectedAgentId }) => {
      const request = {
        payload: { text: "hi" },
        channel: "slack" as const,
        to: "channel:C123",
        sessionKey,
        agentId: "finance",
        cfg: {
          agents: { ownership: "explicit" as const, entries: { main: {}, finance: {} } },
        },
        isGroup: true,
        groupId: "channel:C123",
      };
      await routeTestReply(request);
      expect(lastDelivery().session).toMatchObject({ agentId: expectedAgentId });
      const mirror = lastDelivery().mirror as Record<string, unknown>;
      expect(mirror.agentId).toBe(expectedAgentId);
      expect(mirror.sessionKey).toBe(sessionKey);
      expect(mirror.text).toBe("hi");
      expect(mirror.isGroup).toBe(true);
      expect(mirror.groupId).toBe("channel:C123");
    },
  );

  it.each([
    ["throw", false, undefined, "held"],
    ["throw", true, undefined, "released"],
    ["throw", true, "visible-1", "held"],
    ["best-effort return", false, undefined, "released"],
    ["best-effort return", true, undefined, "held"],
    ["best-effort return", true, "visible-1", "released"],
  ] as const)(
    "projects %s with sentBeforeError=%s, messageId=%s, and custody=%s through durable send",
    async (failureMode, sentBeforeError, messageId, queueCustody) => {
      const cause = new Error("transport failed");
      const results = messageId ? [{ channel: "slack" as const, messageId }] : [];
      const outcome = {
        index: 0,
        status: "failed",
        error: cause,
        sentBeforeError,
        stage: "platform_send",
        results,
      } satisfies OutboundPayloadDeliveryOutcome;
      const error = new OutboundDeliveryError(cause.message, {
        cause,
        results,
        payloadOutcomes: [outcome],
        stage: "platform_send",
      });
      error.queueCustody = queueCustody;
      mocks.deliverOutboundPayloads.mockImplementationOnce(
        async ({ onPayloadDeliveryOutcome }: DeliverOutboundPayloadsParams) => {
          if (failureMode === "throw") {
            throw error;
          }
          onPayloadDeliveryOutcome?.({ ...outcome, error });
          return results;
        },
      );

      const result = await routeTestReply({
        payload: { text: "hello" },
        channel: "slack",
        to: "channel:C123",
      });

      expect(result).toEqual({
        ok: false,
        delivered: Boolean(messageId),
        error: "Failed to route reply to slack: transport failed",
        cause: expect.objectContaining({ cause, queueCustody, sentBeforeError }),
        messageId,
        queueCustody,
        ...(!messageId && sentBeforeError ? { ambiguous: true } : {}),
      });
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps unidentified adapter acceptance ambiguous without confirming visibility", async () => {
    mocks.deliverOutboundPayloads.mockImplementationOnce(
      async ({ onPayloadDeliveryOutcome }: DeliverOutboundPayloadsParams) => {
        onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "adapter_returned_no_identity",
        });
        return [];
      },
    );

    const result = await routeTestReply({
      payload: { text: "hello" },
      channel: "slack",
      to: "channel:C123",
    });

    expect(result).toEqual({
      ok: true,
      delivered: false,
      ambiguous: true,
      reason: "adapter_returned_no_identity",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });
});
