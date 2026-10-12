// Covers source-delivery target matching, message-tool ownership plans, and
// fallback satisfaction outcomes.
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

describe("source delivery plan", () => {
  it("normalizes message-tool delivery outcomes against the planned source target", () => {
    const contract = messageToolPlan({
      channel: "feishu",
      to: "oc_123",
      accountId: "bot-a",
      threadId: 456,
    });

    const outcome = resolveSourceDeliveryOutcome(contract, {
      didSendViaMessageTool: true,
      messageToolSentTargets: [
        {
          tool: "message",
          provider: "message",
          accountId: "bot-a",
          to: "oc_123:topic:456",
          text: "done",
        },
      ],
    });

    expect(outcome.satisfiesSourceDelivery).toBe(true);
    expect(outcome.verifiedMessageToolDelivery).toBe(true);
    expect(outcome.unverifiedMessageToolDelivery).toBe(false);
    expect(outcome.visibleDeliveries).toEqual([
      {
        via: "message_tool",
        verifiedTarget: true,
        target: {
          tool: "message",
          provider: "message",
          accountId: "bot-a",
          to: "oc_123:topic:456",
          text: "done",
        },
      },
    ]);
  });

  it("does not satisfy delivery from target metadata without a committed message-tool send", () => {
    const contract = messageToolPlan({ channel: "slack", to: "channel:C1" });

    const outcome = resolveSourceDeliveryOutcome(contract, {
      didSendViaMessageTool: false,
      messageToolSentTargets: [{ tool: "message", provider: "slack", to: "channel:C1" }],
    });

    expect(outcome.visibleDeliveries[0]?.verifiedTarget).toBe(true);
    expect(outcome.verifiedMessageToolDelivery).toBe(false);
    expect(outcome.satisfiesSourceDelivery).toBe(false);
    expect(outcome.unverifiedMessageToolDelivery).toBe(false);
  });

  it("synthesizes the planned target for legacy message-tool sends by default", () => {
    const contract = messageToolPlan({ channel: "slack", to: "channel:C1" });

    const outcome = resolveSourceDeliveryOutcome(contract, {
      didSendViaMessageTool: true,
    });

    expect(outcome.visibleDeliveries).toEqual([
      {
        via: "message_tool",
        verifiedTarget: true,
        target: { tool: "message", provider: "slack", to: "channel:C1" },
      },
    ]);
    expect(outcome.verifiedMessageToolDelivery).toBe(true);
    expect(outcome.satisfiesSourceDelivery).toBe(true);
  });

  it("matches source targets through the same provider normalization used by delivery", () => {
    expect(
      isVerifiedSourceDeliveryTarget(
        { provider: "message", to: "channel:C1" },
        { channel: "slack", to: "channel:C1" },
      ),
    ).toBe(true);
    expect(
      isVerifiedSourceDeliveryTarget(
        { provider: "discord", to: "channel:C1" },
        { channel: "slack", to: "channel:C1" },
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "case-sensitive metadata",
      channel: "exact-chat",
      comparison: "case-sensitive" as const,
      targetTo: "channel:abc",
      deliveryTo: "channel:ABC",
      expected: false,
    },
    {
      name: "lowercase metadata",
      channel: "folded-chat",
      comparison: "lowercase" as const,
      targetTo: "Channel: c1",
      deliveryTo: "channel:C1",
      expected: true,
    },
    {
      name: "undeclared generic normalization",
      channel: "generic-chat",
      comparison: undefined,
      targetTo: "channel:abc",
      deliveryTo: "channel:ABC",
      expected: false,
    },
  ])(
    "uses $name for prefixed target ids",
    ({ channel, comparison, targetTo, deliveryTo, expected }) => {
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
    [
      "different topics in the same chat",
      { to: "-100:topic:111" },
      { to: "-100:topic:462" },
      false,
    ],
    [
      "suppressed implicit threading",
      { to: "-100", threadImplicit: true, threadSuppressed: true },
      { to: "-100:topic:462" },
      false,
    ],
    [
      "explicit send thread taking precedence over its topic suffix",
      { to: "-100:topic:462", threadId: "111" },
      { to: "-100:topic:462" },
      false,
    ],
    [
      "explicit source thread taking precedence over its topic suffix",
      { to: "-100:topic:462" },
      { to: "-100:topic:462", threadId: 111 },
      false,
    ],
  ] as const)(
    "requires matching conversation and thread evidence: %s",
    (_name, sent, source, verified) => {
      const plan = messageToolPlan({ channel: "telegram", ...source });
      const outcome = resolveSourceDeliveryOutcome(plan, {
        didSendViaMessageTool: true,
        messageToolSentTargets: [{ provider: "telegram", ...sent }],
      });

      expect(outcome.verifiedMessageToolDelivery).toBe(verified);
      expect(outcome.satisfiesSourceDelivery).toBe(verified);
      expect(outcome.unverifiedMessageToolDelivery).toBe(!verified);
    },
  );

  it.each([
    [
      "missing observed recipient",
      { provider: "telegram", to: undefined },
      { channel: "telegram", to: "123456" },
      false,
    ],
    [
      "different account owners",
      { provider: "telegram", to: "123456", accountId: "bot-a" },
      { channel: "telegram", to: "123456", accountId: "bot-b" },
      false,
    ],
  ] as const)(
    "verifies source delivery through its public outcome: %s",
    (_name, observed, destination, verified) => {
      expect(isVerifiedSourceDeliveryTarget(observed, destination)).toBe(verified);
    },
  );
});
