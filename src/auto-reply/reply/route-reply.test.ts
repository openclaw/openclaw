import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
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
  deliverOutboundPayloads:
    vi.fn<typeof import("../../infra/outbound/deliver.js").deliverOutboundPayloads>(),
}));

vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

// mock-isolation: Delivery routing runs without the process-global plugin hook registry.
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => undefined,
}));

const { routeReply } = await import("./route-reply.js");
type RouteReplyParams = Parameters<typeof routeReply>[0];

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
  adapters: Pick<ChannelPlugin, "messaging" | "threading"> = {},
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id,
      label: String(id),
      config: { listAccountIds: () => [], resolveAccount: () => ({}) },
    }),
    ...adapters,
  };
}
function register(...plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, plugin, source: "test" }))),
  );
}

function lastDelivery() {
  const delivery = mocks.deliverOutboundPayloads.mock.lastCall?.[0];
  assert(delivery, "Expected outbound delivery");
  return delivery;
}
function expectLastDeliveryFields(fields: Record<string, unknown>) {
  const delivery = lastDelivery();
  for (const [key, expected] of Object.entries(fields)) {
    expect(Reflect.get(delivery, key)).toEqual(expected);
  }
}
function lastDeliveryPayload() {
  const payload = lastDelivery().payloads[0];
  assert(payload, "Expected delivery payload");
  return payload;
}

function routeTestReply(
  payload: RouteReplyParams["payload"],
  overrides: Partial<RouteReplyParams> = {},
) {
  return routeReply({
    cfg: {},
    channel: "slack",
    to: "channel:C123",
    replyKind: "final",
    payload,
    ...overrides,
  });
}

async function expectSlackNoDelivery(
  payload: Parameters<typeof routeReply>[0]["payload"],
  overrides: Partial<Parameters<typeof routeReply>[0]> = {},
) {
  mocks.deliverOutboundPayloads.mockClear();
  const res = await routeTestReply(payload, overrides);
  expect(res.ok).toBe(true);
  expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  return res;
}

describe("routeReply", () => {
  beforeEach(() => {
    register(
      createChannelPlugin("slack", { messaging: slackMessaging, threading: slackThreading }),
      createChannelPlugin("telegram"),
    );
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
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
    const res = await routeTestReply({ text: "hi" }, { channel, abortSignal: controller.signal });
    expect(res).toMatchObject({ ok: false, delivered: false, error });
    expect(isRetryableDeliveryNotSentError(res.cause)).toBe(true);
    expect(resolveRoutedReplyDeliveryOutcome(res)).toBe("failed-before-deliver");
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "reasoning",
      payload: { text: "step", isReasoning: true },
      outcome: { delivered: false, suppressed: true, reason: "reasoning_payload_not_external" },
    },
    {
      name: "recorded silence",
      payload: setReplyPayloadMetadata({ text: SILENT_REPLY_TOKEN }, { silentReply: true }),
      outcome: {},
    },
    {
      name: "invalid Slack blocks",
      payload: { text: " ", channelData: { slack: { blocks: " " } } },
      outcome: {},
    },
  ])("suppresses $name before delivery", async ({ payload, outcome }) => {
    expect(await expectSlackNoDelivery(payload)).toMatchObject(outcome);
  });

  it("records a channel transform veto before transport or mirroring", async () => {
    const messaging = {
      transformReplyPayload: vi.fn(function (this: unknown) {
        expect(this).toBe(messaging);
        return null;
      }),
    } satisfies ChannelMessagingAdapter;
    register(createChannelPlugin("slack", { messaging, threading: slackThreading }));

    const result = await routeTestReply(
      { text: "private reply" },
      { sessionKey: "agent:main:test" },
    );

    expect(result).toEqual({
      ok: true,
      delivered: false,
      suppressed: true,
      reason: "channel_transform",
    });
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does not drop payloads that merely start with the silent token", async () => {
    const res = await routeTestReply({ text: `${SILENT_REPLY_TOKEN} -- (why am I here?)` });
    expect(res.ok).toBe(true);
    expectLastDeliveryFields({ channel: "slack", to: "channel:C123" });
    expect(lastDeliveryPayload().text).toBe(`${SILENT_REPLY_TOKEN} -- (why am I here?)`);
  });

  it("passes replayable reply payload hook context to routed delivery", async () => {
    const res = await routeTestReply(
      { text: "hello" },
      {
        channel: "telegram",
        to: "chat-1",
        accountId: "acct-1",
        sessionKey: "agent:main:test",
        requesterSenderId: "sender-1",
        replyKind: "block",
        runId: "run-1",
        deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:item-1",
      },
    );

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

  it.each([
    { sameRoute: true, expectedReply: "999.000" },
    { sameRoute: false, expectedReply: null },
  ])(
    "selects payload reply policy only for the same destination ($sameRoute)",
    async ({ sameRoute, expectedReply }) => {
      const payload = setReplyPayloadMetadata(
        { text: "hello", replyToId: "999.000" },
        {
          replyDelivery: { chatType: sameRoute ? "channel" : "direct", replyToMode: "all" },
          replyDeliverySource: sameRoute
            ? { channel: "slack", accountId: "primary" }
            : { channel: "webchat" },
        },
      );
      const res = await routeTestReply(payload, {
        ...(sameRoute ? { accountId: "primary" } : {}),
        replyDelivery: { chatType: "channel", replyToMode: "off" },
      });
      expect(res.ok).toBe(true);
      expectLastDeliveryFields({ replyToId: expectedReply, threadId: null });
      expect(lastDeliveryPayload().replyToId).toBe(expectedReply ?? undefined);
    },
  );

  it("suppresses routed delivery when reply payload hooks empty the payload", async () => {
    mocks.deliverOutboundPayloads.mockImplementationOnce(async ({ onPayloadDeliveryOutcome }) => {
      onPayloadDeliveryOutcome?.({
        index: 0,
        status: "suppressed",
        reason: "empty_after_reply_payload_sending_hook",
      });
      return [];
    });

    const res = await routeTestReply({ text: "hello" }, { channel: "telegram", to: "chat-1" });

    expect(res).toEqual({
      ok: true,
      delivered: false,
      suppressed: true,
      reason: "empty_after_reply_payload_sending_hook",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("uses the policy session's direct conversation type over a group routing hint", async () => {
    const res = await routeTestReply(
      { text: "native command response" },
      {
        sessionKey: "agent:main:main",
        policySessionKey: "agent:main:slack:direct:U123",
        isGroup: true,
      },
    );

    expect(res.ok).toBe(true);
    expect(lastDeliveryPayload().text).toBe("native command response");
    const session = lastDelivery().session;
    expect(session).toMatchObject({
      key: "agent:main:main",
      policyKey: "agent:main:slack:direct:U123",
      conversationType: "direct",
    });
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
    await routeTestReply(
      { text: "hi" },
      {
        accountId: "support",
        sessionKey: "agent:main:main",
        responsePrefixContext: { modelFull: "anthropic/claude-opus-4-6", thinkingLevel: "high" },
        cfg,
      },
    );
    expect(lastDeliveryPayload().text).toBe("[anthropic/claude-opus-4-6 think:high] hi");
  });

  it.each([
    {
      name: "BTW",
      payload: { text: "323", btw: { question: "what is 17 * 19?" } },
      expected: { text: "BTW\nQuestion: what is 17 * 19?\n\n323" },
    },
    {
      name: "multiple media",
      payload: { text: "caption", mediaUrls: ["a", "b"] },
      expected: { text: "caption", mediaUrls: ["a", "b"] },
    },
  ])("preserves $name in the outbound payload", async ({ payload, expected }) => {
    await routeTestReply(payload);
    expectLastDeliveryFields({ channel: "slack" });
    expect(lastDeliveryPayload()).toMatchObject(expected);
  });

  it("preserves delivery and mirror ownership for global", async () => {
    await routeTestReply(
      { text: "hi" },
      {
        sessionKey: "global",
        agentId: "finance",
        cfg: { agents: { ownership: "explicit", entries: { main: {}, finance: {} } } },
        isGroup: true,
        groupId: "channel:C123",
      },
    );
    expect(lastDelivery()).toMatchObject({
      session: { agentId: "finance" },
      mirror: {
        agentId: "finance",
        sessionKey: "global",
        text: "hi",
        isGroup: true,
        groupId: "channel:C123",
      },
    });
  });

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

      const result = await routeTestReply({ text: "hello" });

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
});
