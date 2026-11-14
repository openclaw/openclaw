import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

vi.mock("./target-normalization.js", () => ({
  normalizeTargetForProvider: (_provider: string, raw?: string) => raw?.trim(),
}));
import { resolveSourceDeliveryOutcome, type SourceDeliveryPlan } from "./source-delivery-plan.js";
import type { SourceDeliveryMessageToolTarget } from "./source-delivery-plan.types.js";

const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});

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
  target: SourceDeliveryMessageToolTarget,
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
type EvidenceCase = { sent: SourceDeliveryMessageToolTarget; source: SourceDeliveryPlan["target"] };

describe("source delivery plan", () => {
  it("asks the channel whether an encoded topic target is the planned source thread", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
    expect(
      deliveryOutcome(
        { provider: "message", accountId: "a", to: "-100:topic:456" },
        { channel: "telegram", to: "-100", accountId: "a", threadId: 456 },
      ),
    ).toMatchObject(outcomeFlags(true));
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
    ["case-sensitive", false],
    ["lowercase", true],
    [undefined, false],
  ] as const)("uses %s metadata for prefixed target ids", (comparison, expected) => {
    const channel = "fixture";
    const plugin = {
      ...createChannelTestPluginBase({ id: channel }),
      messaging: comparison ? { targetIdComparison: comparison } : {},
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: channel, source: "test", plugin }]));

    expect(
      deliveryOutcome({ provider: channel, to: "Channel: abc" }, { channel, to: "channel:ABC" })
        .verifiedMessageToolDelivery,
    ).toBe(expected);
  });

  it.each`
    name                        | sent                                                            | source
    ${"different topics"}       | ${{ to: "-100:topic:111" }}                                     | ${{ to: "-100:topic:462" }}
    ${"suppressed thread"}      | ${{ to: "-100", threadImplicit: true, threadSuppressed: true }} | ${{ to: "-100:topic:462" }}
    ${"explicit send thread"}   | ${{ to: "-100:topic:462", threadId: "111" }}                    | ${{ to: "-100:topic:462" }}
    ${"explicit source thread"} | ${{ to: "-100:topic:462" }}                                     | ${{ to: "-100:topic:462", threadId: 111 }}
    ${"missing recipient"}      | ${{ to: undefined }}                                            | ${{ to: "123456" }}
    ${"different accounts"}     | ${{ to: "123456", accountId: "bot-a" }}                         | ${{ to: "123456", accountId: "bot-b" }}
  `(
    "requires matching conversation and thread evidence: $name",
    ({ sent, source }: EvidenceCase) => {
      expect(
        deliveryOutcome({ provider: "telegram", ...sent }, { channel: "telegram", ...source }),
      ).toMatchObject(outcomeFlags(false, true));
    },
  );
});
