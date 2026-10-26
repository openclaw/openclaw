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
      finalByDefault: true,
    },
    fallback: { directDelivery: true, skipWhenMessageToolSentToTarget: true },
  };
}

function deliveryOutcome(
  target: NonNullable<
    Parameters<typeof resolveSourceDeliveryOutcome>[1]["messageToolSentTargets"]
  >[number],
  delivery: SourceDeliveryPlan["target"],
) {
  return resolveSourceDeliveryOutcome(messageToolPlan(delivery), {
    didSendViaMessageTool: true,
    messageToolSentTargets: [target],
  });
}
const slackDestination = { channel: "slack", to: "channel:C1" };
const slackSend = { tool: "message", provider: "slack", to: "channel:C1" };
const outcomeFlags = (verified: boolean, unverified = false) => ({
  satisfiesSourceDelivery: verified,
  verifiedMessageToolDelivery: verified,
  unverifiedMessageToolDelivery: unverified,
});

describe("source delivery plan", () => {
  it("normalizes message-tool delivery outcomes against the planned source target", () => {
    const target = {
      tool: "message",
      provider: "message",
      accountId: "bot-a",
      to: "oc_123:topic:456",
      text: "done",
    };
    expect(
      deliveryOutcome(target, {
        channel: "feishu",
        to: "oc_123",
        accountId: "bot-a",
        threadId: 456,
      }),
    ).toEqual({
      ...outcomeFlags(true),
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
      ...outcomeFlags(verified),
    });
  });

  it("matches source targets through the same provider normalization used by delivery", () => {
    expect(
      ["message", "discord"].map(
        (provider) =>
          deliveryOutcome({ provider, to: "channel:C1" }, slackDestination)
            .verifiedMessageToolDelivery,
      ),
    ).toEqual([true, false]);
  });

  it.each([
    ["case-sensitive", "exact-chat", "channel:abc", "channel:ABC", false],
    ["lowercase", "folded-chat", "Channel: c1", "channel:C1", true],
    [undefined, "generic-chat", "channel:abc", "channel:ABC", false],
  ] as const)(
    "uses %s metadata for prefixed target ids",
    (comparison, channel, targetTo, deliveryTo, expected) => {
      const plugin = {
        ...createChannelTestPluginBase({ id: channel, label: channel }),
        messaging: comparison ? { targetIdComparison: comparison } : {},
      };
      setActivePluginRegistry(createTestRegistry([{ pluginId: channel, source: "test", plugin }]));

      expect(
        deliveryOutcome({ provider: channel, to: targetTo }, { channel, to: deliveryTo })
          .verifiedMessageToolDelivery,
      ).toBe(expected);
    },
  );

  it.each([
    ["different topics in the same chat", { to: "-100:topic:111" }, { to: "-100:topic:462" }],
    [
      "suppressed thread",
      { to: "-100", threadImplicit: true, threadSuppressed: true },
      { to: "-100:topic:462" },
    ],
    ["explicit send thread", { to: "-100:topic:462", threadId: "111" }, { to: "-100:topic:462" }],
    ["explicit source thread", { to: "-100:topic:462" }, { to: "-100:topic:462", threadId: 111 }],
    ["missing observed recipient", { to: undefined }, { to: "123456" }],
    [
      "different account owners",
      { to: "123456", accountId: "bot-a" },
      { to: "123456", accountId: "bot-b" },
    ],
  ] as const)("requires matching conversation and thread evidence: %s", (_name, sent, source) => {
    expect(
      deliveryOutcome({ provider: "telegram", ...sent }, { channel: "telegram", ...source }),
    ).toMatchObject(outcomeFlags(false, true));
  });
});
