import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
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
import { createDefaults, createTurn as createBaseTurn } from "./followup-delivery.test-helpers.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";

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
  buildAgentRuntimeDeliveryPlan: () => ({ resolveFollowupRoute: () => undefined }),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloadsInternal: (...args: unknown[]) => channelState.deliver(...args),
}));

const createChannelPlugin = (id: ChannelPlugin["id"]): ChannelPlugin =>
  createChannelTestPluginBase({ id, config: { listAccountIds: () => [] } });

function register(...plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, plugin, source: "test" }))),
  );
}
const currentReply = {
  text: "Compacting context",
  replyToId: "222.000",
  replyToCurrent: true,
  isCompactionNotice: true,
};
const slackTarget = (text: string) => ({
  tool: "slack",
  provider: "slack",
  to: "channel:C1",
  threadId: "111.000",
  text,
});

function registerCurrentReplyThreading() {
  const slack = createChannelPlugin("slack");
  slack.threading = {
    resolveReplyTransport: (params) => ({
      threadId: null,
      replyToId: params.replyToCurrent ? String(params.threadId) : params.replyToId,
    }),
  };
  register(slack);
}

function createTurn(messageProvider = "discord", originatingChannel = messageProvider) {
  const turn = createBaseTurn({ operation: {} as AdmittedFollowupTurn["operation"] });
  turn.queued.originatingChannel = originatingChannel;
  turn.queued.run.messageProvider = messageProvider;
  return turn;
}

type SendOptions = Partial<
  Pick<
    Parameters<typeof deliverFollowupDecision>[0],
    "defaults" | "kind" | "onObservedReplyDelivery"
  >
>;
function sendToOrigin(
  turn: AdmittedFollowupTurn,
  payloads: ReplyPayload[],
  options: SendOptions = {},
) {
  return deliverFollowupDecision({
    turn,
    decision: { kind: "deliver", payloads },
    defaults: createDefaults(vi.fn(async () => {})),
    runId: "run-1",
    runFollowup: vi.fn(async () => {}),
    ...options,
  });
}

async function deliverBatch(params: {
  messageProvider?: string;
  originatingChannel?: string;
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
  const turn = createTurn(
    params.messageProvider ?? "discord",
    params.originatingChannel ?? "discord",
  );
  turn.queued.deliveryCorrelations = params.correlations;
  const result = await sendToOrigin(turn, params.payloads, {
    defaults: createDefaults(onBlockReply),
    onObservedReplyDelivery: params.onObservedReplyDelivery,
  });
  return { onBlockReply, result };
}

beforeEach(() => {
  register(...(["discord", "imessage", "slack"] as const).map(createChannelPlugin));
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

afterEach(() => setActivePluginRegistry(createTestRegistry()));

describe("follow-up delivery channel boundary", () => {
  it.each(["suppressed", "delivered", "failed", "held", "ambiguous"] as const)(
    "records only confirmed origin delivery (%s)",
    async (outcome) => {
      const passive = vi.fn();
      const explicit = vi.fn();
      const suppressed = outcome === "suppressed";
      const { onBlockReply, result } = await deliverBatch({
        messageProvider: "slack",
        originatingChannel: "slack",
        outcomes: [suppressed ? "delivered" : outcome],
        payloads: [{ text: "Request timed out", isError: true }],
        correlations: [
          { begin() {}, shouldSuppressReply: () => true, onReplyDelivered: passive },
          ...(!suppressed
            ? [{ begin() {}, shouldSuppressReply: () => false, onReplyDelivered: explicit }]
            : []),
        ],
      });
      expect(channelState.deliver).toHaveBeenCalledTimes(suppressed ? 0 : 1);
      expect(passive).toHaveBeenCalledTimes(outcome === "delivered" ? 1 : 0);
      if (suppressed) {
        expect(onBlockReply).not.toHaveBeenCalled();
        expect(result.kind).toBe("completed");
      } else {
        expect(explicit).toHaveBeenCalledTimes(outcome === "delivered" ? 1 : 0);
      }
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
      register(a2aChannelPlugin, createChannelPlugin("slack"));
      const turn = createTurn(channel);
      turn.queued.originatingTo = channel === "a2a" ? "a2a:hermes" : "channel:C1";
      const payloads = [
        { text: "thinking level clamped", isStatusNotice: true },
        { text: "run failed", isError: true },
        setReplyPayloadMetadata({ text: "Gateway restarting" }, { hostNotice: true }),
        { text: "agent answer" },
      ];
      channelState.outcomes = ["delivered", "delivered", "delivered", "delivered"];
      const onBlockReply = vi.fn(async () => {});

      await sendToOrigin(turn, payloads, { defaults: createDefaults(onBlockReply) });

      expect(channelState.deliver.mock.calls.map(([send]) => send.payloads)).toEqual(
        channel === "a2a" ? [[{ text: "agent answer" }]] : payloads.map((payload) => [payload]),
      );
      expect(onBlockReply).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["optional", "discord", "channel:C1", "NO_REPLY.", true],
    ["optional", "discord", "channel:C1", "NO_REPLY", true],
    ["optional", "discord", undefined, "Rate limit reached. Try again later.", false],
    ["required", "webchat", undefined, "The run failed. Please try again.", true],
  ] as const)(
    "preserves %s rejection on %s to %s: %s (deliver=%s)",
    async (expectation, channel, recipient, text, delivered) => {
      const turn = createTurn();
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
        opts: {},
      });

      expect(decision).toMatchObject(
        delivered
          ? { kind: "deliver", payloads: [{ isError: true }] }
          : { kind: "suppress", reason: "silent" },
      );
    },
  );
  it("delivers optional group recovery guidance through a callback-only recipient", async () => {
    const turn = createTurn();
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
    register(source, createChannelPlugin("imessage"));
    const channel = "slack";
    const turn = createTurn(testCase.sourceChannel ?? channel, channel);
    turn.queued.originatingTo = "dm:qa-peer";
    turn.queued.messageId = "new-inbound";
    turn.queued.originatingChatType = "direct";
    turn.queued.run.inputProvenance = testCase.provenance;
    const payload = { text: "queued answer" };
    channelState.outcomes = ["delivered"];
    await sendToOrigin(turn, [payload]);
    expect(channelState.deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel,
        to: "dm:qa-peer",
        replyToId: testCase.expectedReply,
      }),
      undefined,
      undefined,
    );
  });

  it("carries current-reply intent through queued status delivery", async () => {
    registerCurrentReplyThreading();
    const turn = createTurn("discord", "slack");
    turn.queued.originatingThreadId = "111.000";
    channelState.outcomes = ["delivered"];
    await sendToOrigin(turn, [currentReply], { kind: "block" });

    expect(channelState.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ replyToId: "111.000" }),
      undefined,
      undefined,
    );
  });

  it("dedupes a current-reply status against its actual thread root", () => {
    registerCurrentReplyThreading();
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: {},
        payloads: [currentReply],
        messageProvider: "slack",
        originatingChannel: "slack",
        originatingReplyToMode: "all",
        originatingTo: "channel:C1",
        originatingThreadId: "111.000",
        sentTexts: ["Compacting context"],
        sentTargets: [slackTarget("Compacting context")],
      }),
    ).toEqual([]);
  });

  it("renders post-compaction model failures after queued payload selection", async () => {
    const decision = await resolveFollowupDeliveryDecision({
      turn: createTurn(),
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
    register(slack);

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
        sentTargets: [slackTarget("already sent")],
      }),
    ).toEqual([{ text: "first answer", replyToId: "111.000" }]);
  });

  const final = { text: "same-channel final" };
  const status = { text: "status", isStatusNotice: true };
  const privateReply = setReplyPayloadMetadata(
    { text: "private terminal reply" },
    { assistantTranscriptOwned: true },
  );
  const tts = {
    mediaUrl: "file:///tmp/terminal.mp3",
    ttsSupplement: { spokenText: final.text, visibleTextAlreadyDelivered: true },
  };
  it.each(["terminal", "tts", "supplements", "same-channel", "alias"] as const)(
    "recovers only undelivered content after %s failure",
    async (scenario) => {
      const payloads = {
        terminal: [status, privateReply],
        tts: [final, tts],
        supplements: [status, { text: "status two", isFallbackNotice: true }],
        "same-channel": [status, final],
        alias: [final],
      }[scenario];
      const sameChannel = scenario === "same-channel" || scenario === "alias";
      const { onBlockReply } = await deliverBatch({
        messageProvider: scenario === "alias" ? "imessage" : sameChannel ? "slack" : "discord",
        originatingChannel: scenario === "alias" ? "imsg" : "slack",
        outcomes:
          scenario === "alias"
            ? ["failed"]
            : scenario === "supplements"
              ? ["failed", "failed"]
              : ["delivered", "failed"],
        payloads,
      });
      if (scenario === "tts") {
        expect(onBlockReply).not.toHaveBeenCalled();
      } else {
        expect(onBlockReply).toHaveBeenCalledOnce();
        if (sameChannel) {
          expect(onBlockReply).toHaveBeenCalledWith(final);
        } else {
          const recovered = onBlockReply.mock.calls[0]?.[0];
          expect(recovered?.text).toContain("could not deliver");
          if (scenario === "terminal") {
            expect(recovered).toMatchObject({ isError: true });
            expect(recovered?.text).not.toContain(privateReply.text);
          }
        }
      }
    },
  );
});
