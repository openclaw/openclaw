import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { resolveSessionDeliveryTargetFromKey } from "./sessions-send-helpers.js";

function expectTarget(
  key: string,
  expected: NonNullable<ReturnType<typeof resolveSessionDeliveryTargetFromKey>>,
) {
  expect(resolveSessionDeliveryTargetFromKey(key)).toEqual({ threadId: undefined, ...expected });
}
function useMessaging(id: string, messaging: ChannelMessagingAdapter) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: id,
        source: "test",
        plugin: { ...createChannelTestPluginBase({ id }), messaging },
      },
    ]),
  );
}

describe("resolveSessionDeliveryTargetFromKey", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it.each([
    ["discord:group:dev", { channel: "discord", to: "channel:dev" }],
    ["slack:group:C123", { channel: "slack", to: "channel:C123" }],
    [
      "slack:channel:general:thread:1699999999.0001",
      { channel: "slack", to: "channel:general", threadId: "1699999999.0001" },
    ],
    [
      "feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      { channel: "feishu", to: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user" },
    ],
    [
      "feishu:work:dm:ou_recipient",
      { channel: "feishu", to: "user:ou_recipient", accountId: "work" },
    ],
    ["wecom:direct:opaque-recipient", { channel: "wecom", to: "user:opaque-recipient" }],
  ] as const)("resolves the plugin-owned target for %s", (suffix, expected) => {
    expectTarget(`agent:main:${suffix}`, expected);
  });

  it("does not reinterpret a nested agent session as an external direct target", () => {
    expect(
      resolveSessionDeliveryTargetFromKey("agent:main:agent:other:feishu:direct:ou_recipient"),
    ).toBeNull();
  });

  it("keeps a safe user target when a direct delivery resolver returns null", () => {
    useMessaging("feishu", {
      normalizeTarget: (target: string) => target,
      resolveDeliveryTarget: () => null,
    });
    expectTarget("agent:main:feishu:direct:ou_recipient", {
      channel: "feishu",
      to: "user:ou_recipient",
    });
  });

  it("does not let a room delivery resolver convert a direct user into a channel", () => {
    useMessaging("slack", {
      directTargetStyle: "user-prefixed",
      targetIdComparison: "lowercase",
      normalizeTarget: (target: string) => target.toLowerCase(),
      resolveDeliveryTarget: ({ conversationId }: { conversationId: string }) => ({
        to: `channel:${conversationId}`,
      }),
    });
    expectTarget("agent:main:slack:direct:U09G2DJ0275", {
      channel: "slack",
      to: "user:u09g2dj0275",
    });
  });
});
