import { afterEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

vi.mock("./target-normalization.js", () => ({
  normalizeTargetForProvider: (_provider: string, raw?: string) => raw?.trim(),
}));
import { resolveSourceDeliveryOutcome, type SourceDeliveryPlan } from "./source-delivery-plan.js";

afterEach(() => {
  setActivePluginRegistry(createTestRegistry());
});

function messageToolPlan(target: SourceDeliveryPlan["target"]): SourceDeliveryPlan {
  return {
    owner: "message_tool_then_direct_fallback",
    reason: "subagent_completion",
    target,
    normalFinal: "private",
    sourceReplyDeliveryMode: "message_tool_only",
    messageTool: {
      enabled: true,
      force: true,
      requireExplicitTarget: false,
      requireExplicitTargetEvidence: false,
    },
    fallback: { directDelivery: true, skipWhenMessageToolSentToTarget: true },
  };
}

function isVerifiedSourceDeliveryTarget(
  target: NonNullable<
    Parameters<typeof resolveSourceDeliveryOutcome>[1]["messageToolSentTargets"]
  >[number],
  delivery: SourceDeliveryPlan["target"],
): boolean {
  const plan = messageToolPlan(delivery);
  return resolveSourceDeliveryOutcome(plan, {
    didSendViaMessageTool: true,
    messageToolSentTargets: [target],
  }).verifiedMessageToolDelivery;
}
const slackDestination = { channel: "slack", to: "channel:C1" };
const slackSend = { tool: "message", provider: "slack", to: "channel:C1" };

describe("source delivery plan", () => {
  it("normalizes message-tool delivery outcomes against the planned source target", () => {
    const contract = messageToolPlan({
      channel: "feishu",
      to: "oc_123",
      accountId: "bot-a",
      threadId: 456,
    });

    const target = {
      tool: "message",
      provider: "message",
      accountId: "bot-a",
      to: "oc_123:topic:456",
      text: "done",
    };
    expect(
      resolveSourceDeliveryOutcome(contract, {
        didSendViaMessageTool: true,
        messageToolSentTargets: [{ ...target }],
      }),
    ).toEqual({
      satisfiesSourceDelivery: true,
      verifiedMessageToolDelivery: true,
      unverifiedMessageToolDelivery: false,
      visibleDeliveries: [{ via: "message_tool", verifiedTarget: true, target }],
    });
  });

  it.each([
    ["does not satisfy uncommitted target metadata", false, [slackSend], false],
    ["synthesizes the target for legacy sends", true, undefined, true],
  ] as const)("%s", (_name, didSendViaMessageTool, sent, verified) => {
    const outcome = resolveSourceDeliveryOutcome(messageToolPlan(slackDestination), {
      didSendViaMessageTool,
      messageToolSentTargets: sent?.map((target) => ({ ...target })),
    });
    expect(outcome).toEqual({
      visibleDeliveries: [{ via: "message_tool", verifiedTarget: true, target: slackSend }],
      verifiedMessageToolDelivery: verified,
      satisfiesSourceDelivery: verified,
      unverifiedMessageToolDelivery: false,
    });
  });

  it("matches source targets through the same provider normalization used by delivery", () => {
    expect(
      isVerifiedSourceDeliveryTarget({ provider: "message", to: "channel:C1" }, slackDestination),
    ).toBe(true);
    expect(
      isVerifiedSourceDeliveryTarget({ provider: "discord", to: "channel:C1" }, slackDestination),
    ).toBe(false);
  });

  it.each([
    ["case-sensitive", "exact-chat", "channel:abc", "channel:ABC", false],
    ["lowercase", "folded-chat", "Channel: c1", "channel:C1", true],
    [undefined, "generic-chat", "channel:abc", "channel:ABC", false],
  ] as const)(
    "uses %s metadata for prefixed target ids",
    (comparison, channel, targetTo, deliveryTo, expected) => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: channel,
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: channel, label: channel }),
              messaging: comparison ? { targetIdComparison: comparison } : {},
            },
          },
        ]),
      );

      expect(
        isVerifiedSourceDeliveryTarget(
          { provider: channel, to: targetTo },
          { channel, to: deliveryTo },
        ),
      ).toBe(expected);
    },
  );

  it.each([
    ["different topics in the same chat", { to: "-100:topic:111" }, { to: "-100:topic:462" }],
    [
      "suppressed implicit threading",
      { to: "-100", threadImplicit: true, threadSuppressed: true },
      { to: "-100:topic:462" },
    ],
    [
      "explicit send thread taking precedence over its topic suffix",
      { to: "-100:topic:462", threadId: "111" },
      { to: "-100:topic:462" },
    ],
    [
      "explicit source thread taking precedence over its topic suffix",
      { to: "-100:topic:462" },
      { to: "-100:topic:462", threadId: 111 },
    ],
  ] as const)("requires matching conversation and thread evidence: %s", (_name, sent, source) => {
    const plan = messageToolPlan({ channel: "telegram", ...source });
    const outcome = resolveSourceDeliveryOutcome(plan, {
      didSendViaMessageTool: true,
      messageToolSentTargets: [{ provider: "telegram", ...sent }],
    });

    expect(outcome).toMatchObject({
      verifiedMessageToolDelivery: false,
      satisfiesSourceDelivery: false,
      unverifiedMessageToolDelivery: true,
    });
  });

  it.each([
    [
      "missing observed recipient",
      { provider: "telegram", to: undefined },
      { channel: "telegram", to: "123456" },
    ],
    [
      "different account owners",
      { provider: "telegram", to: "123456", accountId: "bot-a" },
      { channel: "telegram", to: "123456", accountId: "bot-b" },
    ],
  ] as const)(
    "verifies source delivery through its public outcome: %s",
    (_name, observed, destination) => {
      expect(isVerifiedSourceDeliveryTarget(observed, destination)).toBe(false);
    },
  );
});
