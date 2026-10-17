// Proves follow-up batch ownership through the real channel route and durable-send boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { OutboundDeliveryError } from "../../infra/outbound/deliver-types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { setBlockReplyDelivery } from "./block-reply-delivery.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";

const { a2aChannelPlugin } = await loadBundledPluginFacade<{ a2aChannelPlugin: ChannelPlugin }>({
  pluginId: "a2a",
  artifactBasename: "channel-plugin-api.js",
});

const channelState = vi.hoisted(() => ({
  outcomes: [] as Array<"delivered" | "failed" | "held" | "ambiguous">,
  deliver: vi.fn(),
}));

// mock-isolation: channel custody tests provide the follow-up route without loading model or auth plans.
vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({
    resolveFollowupRoute: () => undefined,
  }),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloadsInternal: (...args: unknown[]) => channelState.deliver(...args),
}));

function createChannelPlugin(id: ChannelPlugin["id"]): ChannelPlugin {
  return createChannelTestPluginBase({
    id,
    label: String(id),
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
  });
}

function registerCurrentReplyThreading() {
  const slack = createChannelPlugin("slack");
  slack.threading = {
    resolveReplyTransport: (params: {
      threadId?: string | number | null;
      replyToId?: string | null;
      replyToCurrent?: boolean;
    }) => ({
      threadId: null,
      replyToId: params.replyToCurrent ? String(params.threadId) : params.replyToId,
    }),
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", plugin: slack, source: "test" }]),
  );
}

function createTurn(params: {
  messageProvider: string;
  originatingChannel: string;
}): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: {
      prompt: "queued",
      enqueuedAt: 1,
      originatingChannel: params.originatingChannel,
      originatingTo: "channel:C1",
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        provider: "anthropic",
        model: "claude",
        messageProvider: params.messageProvider,
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {} as AdmittedFollowupTurn["operation"],
    config: {} as OpenClawConfig,
    session: {
      kind: "session",
      key: "main",
      current: () => undefined,
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  };
}

function createDefaults(onBlockReply: (payload: ReplyPayload) => Promise<void>) {
  return {
    defaultModel: "claude",
    typingMode: "never" as const,
    typing: {
      onReplyStart: vi.fn(async () => {}),
      startTypingLoop: vi.fn(async () => {}),
      startTypingOnText: vi.fn(async () => {}),
      refreshTypingTtl: vi.fn(),
      isActive: vi.fn(() => false),
      markRunComplete: vi.fn(),
      markDispatchIdle: vi.fn(),
      cleanup: vi.fn(),
    },
    opts: { onBlockReply },
  };
}

async function deliverBatch(params: {
  messageProvider: string;
  originatingChannel: string;
  outcomes: typeof channelState.outcomes;
  payloads: ReplyPayload[];
  fallbackOutcome?: "delivered" | "failed-before-deliver" | "channel-transform" | "recovery-owned";
  fallbackPending?: boolean;
  onObservedReplyDelivery?: () => void;
  correlations?: AdmittedFollowupTurn["queued"]["deliveryCorrelations"];
}) {
  channelState.outcomes = [...params.outcomes];
  const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {
    if (params.fallbackOutcome) {
      setBlockReplyDelivery(
        Promise.resolve({ outcome: params.fallbackOutcome, pending: params.fallbackPending }),
      );
    }
  });
  const turn = createTurn(params);
  turn.queued.deliveryCorrelations = params.correlations;
  const result = await deliverFollowupDecision({
    decision: { kind: "deliver", payloads: params.payloads },
    turn,
    defaults: createDefaults(onBlockReply),
    runId: "run-1",
    runFollowup: vi.fn(async () => {}),
    onObservedReplyDelivery: params.onObservedReplyDelivery,
  });
  return { onBlockReply, result };
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry(
      (["discord", "imessage", "slack"] as const).map((id) => ({
        pluginId: id,
        plugin: createChannelPlugin(id),
        source: "test",
      })),
    ),
  );
  channelState.outcomes = [];
  channelState.deliver.mockReset();
  channelState.deliver.mockImplementation(async (params: { channel: string }) => {
    const outcome = channelState.outcomes.shift();
    if (outcome === "delivered") {
      return [{ channel: params.channel, messageId: `message-${channelState.outcomes.length}` }];
    }
    if (outcome === "held" || outcome === "ambiguous") {
      const error = new OutboundDeliveryError("delivery still owned by transport", {
        cause: new Error("transport unavailable"),
        sentBeforeError: outcome === "ambiguous",
      });
      error.queueCustody = outcome === "held" ? "held" : "released";
      throw error;
    }
    throw new Error("simulated channel delivery failure");
  });
});

afterEach(() => {
  setActivePluginRegistry(createTestRegistry());
});

describe("follow-up delivery channel boundary", () => {
  it("suppresses repeated source failures before transport without falling back to another dispatcher", async () => {
    const delivered = vi.fn();
    const { onBlockReply, result } = await deliverBatch({
      messageProvider: "slack",
      originatingChannel: "slack",
      outcomes: ["delivered"],
      payloads: [{ text: "Request timed out", isError: true }],
      correlations: [{ begin() {}, shouldSuppressReply: () => true, onReplyDelivered: delivered }],
    });
    expect(channelState.deliver).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(result.kind).toBe("completed");
  });

  it.each(["delivered", "failed", "held", "ambiguous"] as const)(
    "keeps a collected explicit request visible and records only confirmed origin delivery (%s)",
    async (outcome) => {
      const passive = vi.fn();
      const explicit = vi.fn();
      await deliverBatch({
        messageProvider: "slack",
        originatingChannel: "slack",
        outcomes: [outcome],
        payloads: [{ text: "Request timed out", isError: true }],
        correlations: [
          { begin() {}, shouldSuppressReply: () => true, onReplyDelivered: passive },
          { begin() {}, shouldSuppressReply: () => false, onReplyDelivered: explicit },
        ],
      });
      expect(channelState.deliver).toHaveBeenCalledTimes(1);
      expect(passive).toHaveBeenCalledTimes(outcome === "delivered" ? 1 : 0);
      expect(explicit).toHaveBeenCalledTimes(outcome === "delivered" ? 1 : 0);
    },
  );

  it.each([
    { route: "held", fallback: "delivered", pending: false },
    { route: "ambiguous", fallback: "delivered", pending: false },
    { route: "failed", fallback: "delivered", pending: true },
    { route: "failed", fallback: "recovery-owned", pending: false },
  ] as const)(
    "retains pending transport ownership for $route / $fallback",
    async ({ route, fallback, pending }) => {
      const observed = vi.fn();
      const { result, onBlockReply } = await deliverBatch({
        messageProvider: "discord",
        originatingChannel: "discord",
        outcomes: [route],
        payloads: [{ text: "queued reply" }],
        fallbackOutcome: fallback,
        fallbackPending: pending,
        onObservedReplyDelivery: observed,
      });
      expect(result).toEqual({ kind: "pending", payloads: [] });
      expect(observed).not.toHaveBeenCalled();
      expect(onBlockReply).toHaveBeenCalledTimes(route === "failed" ? 1 : 0);
    },
  );
  it.each([
    { route: "delivered", fallback: "failed-before-deliver", origin: "discord", visible: true },
    { route: "failed", fallback: "failed-before-deliver", origin: "discord", visible: false },
    { route: "failed", fallback: "channel-transform", origin: "discord", visible: false },
    { route: "failed", fallback: "delivered", origin: "discord", visible: true },
    { route: "failed", fallback: "delivered", origin: "slack", visible: false },
  ] as const)(
    "reports settled source visibility for $origin: $route / $fallback",
    async ({ route, fallback, origin, visible }) => {
      const observed = vi.fn();
      await deliverBatch({
        messageProvider: "discord",
        originatingChannel: origin,
        outcomes: [route],
        payloads: [{ text: "queued reply" }],
        fallbackOutcome: fallback,
        onObservedReplyDelivery: observed,
      });
      expect(observed).toHaveBeenCalledTimes(visible ? 1 : 0);
    },
  );
  it.each(["a2a", "slack"])(
    "delivers queued terminal content and keeps host notices specific to human channels: %s",
    async (channel) => {
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "a2a", plugin: a2aChannelPlugin, source: "test" },
          { pluginId: "slack", plugin: createChannelPlugin("slack"), source: "test" },
        ]),
      );
      const turn = createTurn({ messageProvider: channel, originatingChannel: channel });
      turn.queued.originatingTo = channel === "a2a" ? "a2a:hermes" : "channel:C1";
      const payloads = [
        { text: "thinking level clamped", isStatusNotice: true },
        { text: "run failed", isError: true },
        setReplyPayloadMetadata({ text: "Gateway restarting" }, { hostNotice: true }),
        { text: "agent answer" },
      ];
      channelState.outcomes = ["delivered", "delivered", "delivered", "delivered"];
      const onBlockReply = vi.fn(async () => {});

      await deliverFollowupDecision({
        decision: { kind: "deliver", payloads },
        turn,
        defaults: createDefaults(onBlockReply),
        runId: "run-1",
        runFollowup: vi.fn(async () => {}),
      });

      expect(channelState.deliver.mock.calls.map(([send]) => send.payloads)).toEqual(
        channel === "a2a" ? [[{ text: "agent answer" }]] : payloads.map((payload) => [payload]),
      );
      expect(onBlockReply).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "optional group control-looking failure",
      expectation: "optional",
      channel: "discord",
      recipient: "channel:C1",
      text: "NO_REPLY.",
      delivered: true,
    },
    {
      name: "optional group literal control-looking failure",
      expectation: "optional",
      channel: "discord",
      recipient: "channel:C1",
      text: "NO_REPLY",
      delivered: true,
    },
    {
      name: "optional work without a recipient",
      expectation: "optional",
      channel: "discord",
      recipient: undefined,
      text: "Rate limit reached. Try again later.",
      delivered: false,
    },
    {
      name: "required WebChat without a channel recipient",
      expectation: "required",
      channel: "webchat",
      recipient: undefined,
      text: "The run failed. Please try again.",
      delivered: true,
    },
  ] as const)(
    "preserves the producer failure decision for $name",
    async ({ expectation, channel, recipient, text, delivered }) => {
      const turn = createTurn({ messageProvider: "discord", originatingChannel: "discord" });
      turn.queued.run.terminalReplyExpectation = expectation;
      turn.queued.originatingChannel = channel;
      turn.queued.originatingTo = recipient;
      turn.queued.originatingChatType = channel === "webchat" ? "direct" : "group";

      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution: {
          runId: "run-1",
          outcome: { kind: "rejected", payload: { text, isError: true } },
        },
        opts: { isHeartbeat: true },
      });

      expect(decision).toMatchObject(
        delivered
          ? { kind: "deliver", payloads: [{ isError: true }] }
          : { kind: "suppress", reason: "silent" },
      );
    },
  );
  it("delivers optional group recovery guidance through a callback-only recipient", async () => {
    const turn = createTurn({ messageProvider: "discord", originatingChannel: "discord" });
    turn.queued.originatingTo = undefined;
    turn.queued.originatingChatType = "group";
    turn.queued.run.terminalReplyExpectation = "optional";
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    const defaults = createDefaults(onBlockReply);
    const failure = { text: "Rate limit reached. Try again later.", isError: true };
    const decision = await resolveFollowupDeliveryDecision({
      turn,
      execution: { runId: "run-1", outcome: { kind: "rejected", payload: failure } },
      opts: defaults.opts,
    });

    await deliverFollowupDecision({
      decision,
      turn,
      defaults,
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("The AI service needs a short break"),
      }),
    );
  });
  it.each<{
    name: string;
    provenance?: AdmittedFollowupTurn["queued"]["run"]["inputProvenance"];
    sourceChannel?: string;
    expectedReply: string | null;
  }>([
    { name: "implicit current inbound", expectedReply: "new-inbound" },
    {
      name: "restart sentinel",
      provenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
      expectedReply: null,
    },
    { name: "different source channel", sourceChannel: "discord", expectedReply: null },
  ])("passes queued origin message facts to the channel resolver: $name", async (testCase) => {
    const source = createChannelPlugin("slack");
    source.threading = {
      resolveReplyTransport: ({ currentMessageId, replyToId }) => ({
        replyToId: replyToId ?? currentMessageId,
      }),
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "slack", plugin: source, source: "test" },
        { pluginId: "imessage", plugin: createChannelPlugin("imessage"), source: "test" },
      ]),
    );
    const channel = "slack";
    const turn = createTurn({
      messageProvider: testCase.sourceChannel ?? channel,
      originatingChannel: channel,
    });
    turn.queued.originatingTo = "dm:qa-peer";
    turn.queued.messageId = "new-inbound";
    turn.queued.originatingChatType = "direct";
    turn.queued.run.inputProvenance = testCase.provenance;
    const payload = { text: "queued answer" };
    channelState.outcomes = ["delivered"];
    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [payload] },
      turn,
      defaults: createDefaults(vi.fn(async () => {})),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });
    expect(channelState.deliver).toHaveBeenCalledOnce();
    expect(channelState.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        channel,
        to: "dm:qa-peer",
        replyToId: testCase.expectedReply,
      }),
      undefined,
    );
  });

  it("carries current-reply intent through queued status delivery", async () => {
    registerCurrentReplyThreading();
    const turn = createTurn({ messageProvider: "discord", originatingChannel: "slack" });
    turn.queued.originatingThreadId = "111.000";
    channelState.outcomes = ["delivered"];
    await deliverFollowupDecision({
      decision: {
        kind: "deliver",
        payloads: [
          {
            text: "Compacting context",
            replyToId: "222.000",
            replyToCurrent: true,
            isCompactionNotice: true,
          },
        ],
      },
      turn,
      defaults: createDefaults(vi.fn(async () => {})),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
      kind: "block",
    });

    expect(channelState.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ replyToId: "111.000" }),
      undefined,
    );
  });

  it("dedupes a current-reply status against its actual thread root", () => {
    registerCurrentReplyThreading();
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: {},
        payloads: [
          {
            text: "Compacting context",
            replyToId: "222.000",
            replyToCurrent: true,
            isCompactionNotice: true,
          },
        ],
        messageProvider: "slack",
        originatingChannel: "slack",
        originatingReplyToMode: "all",
        originatingTo: "channel:C1",
        originatingThreadId: "111.000",
        sentTexts: ["Compacting context"],
        sentTargets: [
          {
            tool: "slack",
            provider: "slack",
            to: "channel:C1",
            threadId: "111.000",
            text: "Compacting context",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("renders post-compaction model failures after queued payload selection", async () => {
    const decision = await resolveFollowupDeliveryDecision({
      turn: createTurn({ messageProvider: "discord", originatingChannel: "discord" }),
      execution: {
        runId: "run-1",
        outcome: {
          kind: "rejected",
          payload: { text: "⚠️ Provider billing failed.", isError: true },
          postCompactionModelFailure: true,
        },
      },
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [
        {
          text: "⚠️ Context compaction succeeded, but the later model request still failed. Provider billing failed.",
          isError: true,
        },
      ],
    });
  });

  it("preserves the batched reply slot when earlier media was already sent", () => {
    const duplicatePayload = { mediaUrl: "/tmp/already-sent.png", replyToId: "parent" };

    expect(
      resolveFollowupDeliveryPayloads({
        cfg: {},
        payloads: [duplicatePayload, { text: "actual answer", replyToId: "parent" }],
        originatingChannel: "discord",
        originatingReplyToMode: "batched",
        sentMediaUrls: ["/tmp/already-sent.png"],
        sentTexts: ["already sent"],
      }),
    ).toEqual([{ text: "actual answer", replyToId: "parent" }]);
  });

  it("dedupes later Slack replies against their actual first-mode transport thread", () => {
    const slack = createChannelPlugin("slack");
    slack.threading = {
      resolveReplyTransport: ({ threadId, replyToId, replyToIsExplicit }) => {
        const inheritedThread = threadId == null ? undefined : String(threadId);
        // First-mode can clear replyToId; Slack still falls back to the inherited thread.
        return {
          threadId: null,
          replyToId:
            replyToIsExplicit === false
              ? (inheritedThread ?? replyToId)
              : (replyToId ?? inheritedThread),
        };
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", plugin: slack, source: "test" }]),
    );

    expect(
      resolveFollowupDeliveryPayloads({
        cfg: {},
        payloads: [
          { text: "first answer", replyToId: "111.000" },
          { text: "already sent", replyToId: "222.000" },
        ],
        messageProvider: "slack",
        originatingChannel: "slack",
        originatingReplyToMode: "first",
        originatingTo: "channel:C1",
        originatingThreadId: "111.000",
        sentTexts: ["already sent"],
        sentTargets: [
          {
            tool: "slack",
            provider: "slack",
            to: "channel:C1",
            threadId: "111.000",
            text: "already sent",
          },
        ],
      }),
    ).toEqual([{ text: "first answer", replyToId: "111.000" }]);
  });

  it("emits one safe cross-channel error when a terminal payload fails after status delivery", async () => {
    const { onBlockReply } = await deliverBatch({
      messageProvider: "discord",
      originatingChannel: "slack",
      outcomes: ["delivered", "failed"],
      payloads: [
        { text: "status delivered", isStatusNotice: true },
        setReplyPayloadMetadata(
          { text: "private terminal reply" },
          { assistantTranscriptOwned: true },
        ),
      ],
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ isError: true });
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toContain("could not deliver");
    expect(onBlockReply.mock.calls[0]?.[0]?.text).not.toContain("private terminal reply");
  });

  it("keeps a delivered terminal valid when a later TTS supplement fails", async () => {
    const { onBlockReply } = await deliverBatch({
      messageProvider: "discord",
      originatingChannel: "slack",
      outcomes: ["delivered", "failed"],
      payloads: [
        { text: "terminal reply" },
        {
          mediaUrl: "file:///tmp/terminal.mp3",
          ttsSupplement: { spokenText: "terminal reply", visibleTextAlreadyDelivered: true },
        },
      ],
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("emits one safe error when every supplemental origin delivery fails", async () => {
    const { onBlockReply } = await deliverBatch({
      messageProvider: "discord",
      originatingChannel: "slack",
      outcomes: ["failed", "failed"],
      payloads: [
        { text: "status one", isStatusNotice: true },
        { text: "status two", isFallbackNotice: true },
      ],
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toContain("could not deliver");
  });

  it("returns only the failed payload through same-channel recovery", async () => {
    const failedFinal = { text: "same-channel final" };
    const { onBlockReply } = await deliverBatch({
      messageProvider: "slack",
      originatingChannel: "slack",
      outcomes: ["delivered", "failed"],
      payloads: [{ text: "status", isStatusNotice: true }, failedFinal],
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply).toHaveBeenCalledWith(failedFinal);
  });

  it("keeps alias-equivalent built-in channels on same-channel recovery", async () => {
    const failedFinal = { text: "alias same-channel final" };
    const { onBlockReply } = await deliverBatch({
      messageProvider: "imessage",
      originatingChannel: "imsg",
      outcomes: ["failed"],
      payloads: [failedFinal],
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply).toHaveBeenCalledWith(failedFinal);
  });
});
