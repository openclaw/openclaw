// Tests canonical conversation identity preparation for plugin command binding APIs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { HandleCommandsParams } from "./commands-types.js";
import {
  resolveConversationBindingContextFromMessage,
  resolvePluginCommandConversationBindingContext,
} from "./conversation-binding-input.js";

function buildParams(): HandleCommandsParams {
  return {
    cfg: {},
    ctx: {
      Provider: "internal",
      Surface: "internal",
      OriginatingChannel: "slack",
      OriginatingTo: "user:U123",
      SenderId: "gateway-client",
      To: "slash:gateway-client",
      AccountId: "default",
    },
    command: {
      channel: "slack",
      senderId: "gateway-client",
      from: "gateway-client",
      to: "slash:gateway-client",
    },
  } as unknown as HandleCommandsParams;
}

describe("resolvePluginCommandConversationBindingContext", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("uses the explicit origin with a channel's generic conversation resolver", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
            conversationBindings: { supportsCurrentConversationBinding: true },
          },
        },
      ]),
    );

    expect(resolvePluginCommandConversationBindingContext(buildParams())).toEqual({
      channel: "slack",
      accountId: "default",
      conversationId: "user:U123",
    });
  });

  it("uses the same canonical target for inbound binding lookup", () => {
    const params = buildParams();

    expect(
      resolveConversationBindingContextFromMessage({ cfg: params.cfg, ctx: params.ctx }),
    ).toEqual({
      channel: "slack",
      accountId: "default",
      conversationId: "user:U123",
    });
  });

  it("preserves provider-owned sender-scoped topic identities for inbound binding lookup", () => {
    const resolveCommandConversation = vi.fn(() => ({
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      parentConversationId: "oc_group_chat",
    }));
    const ctx = {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc_group_chat",
      To: "chat:oc_group_chat",
      From: "feishu:ou_sender_1",
      AccountId: "work",
      ChatType: "group",
      MessageThreadId: "om_topic_root",
      SenderId: "ou_sender_1",
      SessionKey: "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      ParentSessionKey: "agent:main:main",
    } as const;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "feishu",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "feishu", label: "Feishu" }),
            bindings: {
              resolveCommandConversation,
            },
          },
        },
      ]),
    );

    expect(
      resolveConversationBindingContextFromMessage({
        cfg: {},
        ctx,
      }),
    ).toEqual({
      channel: "feishu",
      accountId: "work",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      parentConversationId: "oc_group_chat",
      threadId: "om_topic_root",
    });
    expect(
      resolvePluginCommandConversationBindingContext({
        cfg: {},
        ctx,
        sessionKey: ctx.SessionKey,
        command: {
          channel: "feishu",
          senderId: "ou_sender_1",
          from: "feishu:ou_sender_1",
          to: "chat:oc_group_chat",
        },
      } as unknown as HandleCommandsParams),
    ).toEqual({
      channel: "feishu",
      accountId: "work",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      parentConversationId: "oc_group_chat",
      threadId: "om_topic_root",
    });
    expect(resolveCommandConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        threadId: "om_topic_root",
        senderId: "ou_sender_1",
        sessionKey: "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
        parentSessionKey: "agent:main:main",
        from: "feishu:ou_sender_1",
        chatType: "group",
        originatingTo: "chat:oc_group_chat",
        fallbackTo: "chat:oc_group_chat",
      }),
    );
  });

  it("does not expose binding APIs for unsupported channels", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: createChannelTestPluginBase({ id: "slack", label: "Slack" }),
        },
      ]),
    );

    expect(resolvePluginCommandConversationBindingContext(buildParams())).toBeNull();
  });
});
