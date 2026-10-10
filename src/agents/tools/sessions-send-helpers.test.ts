import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { resolveSessionDeliveryTargetFromKey } from "./sessions-send-helpers.js";

describe("resolveSessionDeliveryTargetFromKey", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("lets plugins own session-derived target shapes", () => {
    expect(resolveSessionDeliveryTargetFromKey("agent:main:discord:group:dev")).toEqual({
      channel: "discord",
      to: "channel:dev",
      threadId: undefined,
    });
    expect(resolveSessionDeliveryTargetFromKey("agent:main:slack:group:C123")).toEqual({
      channel: "slack",
      to: "channel:C123",
      threadId: undefined,
    });
  });

  it("preserves decimal thread ids for Slack-style session keys", () => {
    expect(
      resolveSessionDeliveryTargetFromKey(
        "agent:main:slack:channel:general:thread:1699999999.0001",
      ),
    ).toEqual({
      channel: "slack",
      to: "channel:general",
      threadId: "1699999999.0001",
    });
  });

  it("preserves feishu conversation ids that embed :topic: in the base id", () => {
    expect(
      resolveSessionDeliveryTargetFromKey(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      channel: "feishu",
      to: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
    });
  });

  it.each([
    {
      name: "account-scoped dm alias",
      sessionKey: "agent:main:feishu:work:dm:ou_recipient",
      expected: {
        channel: "feishu",
        to: "user:ou_recipient",
        accountId: "work",
        threadId: undefined,
      },
    },
    {
      name: "unregistered channel",
      sessionKey: "agent:main:wecom:direct:opaque-recipient",
      expected: {
        channel: "wecom",
        to: "user:opaque-recipient",
        threadId: undefined,
      },
    },
  ])(
    "resolves $name delivery targets without session-list delivery context",
    ({ sessionKey, expected }) => {
      expect(resolveSessionDeliveryTargetFromKey(sessionKey)).toEqual(expected);
    },
  );

  it("does not reinterpret a nested agent session as an external direct target", () => {
    expect(
      resolveSessionDeliveryTargetFromKey("agent:main:agent:other:feishu:direct:ou_recipient"),
    ).toBeNull();
  });

  it("keeps a safe user target when a direct delivery resolver returns null", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "feishu",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "feishu" }),
            messaging: {
              normalizeTarget: (target: string) => target,
              resolveDeliveryTarget: () => null,
            },
          },
        },
      ]),
    );

    expect(resolveSessionDeliveryTargetFromKey("agent:main:feishu:direct:ou_recipient")).toEqual({
      channel: "feishu",
      to: "user:ou_recipient",
      threadId: undefined,
    });
  });

  it("does not let a room delivery resolver convert a direct user into a channel", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            messaging: {
              directTargetStyle: "user-prefixed",
              targetIdComparison: "lowercase",
              normalizeTarget: (target: string) => target.toLowerCase(),
              resolveDeliveryTarget: ({ conversationId }: { conversationId: string }) => ({
                to: `channel:${conversationId}`,
              }),
            },
          },
        },
      ]),
    );

    expect(resolveSessionDeliveryTargetFromKey("agent:main:slack:direct:U09G2DJ0275")).toEqual({
      channel: "slack",
      to: "user:u09g2dj0275",
      threadId: undefined,
    });
  });
});
