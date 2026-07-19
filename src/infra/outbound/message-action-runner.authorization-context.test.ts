import { afterEach, describe, expect, it, vi } from "vitest";
import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthorizationInvocationContext } from "../../plugins/authorization-policy.types.js";
import { createOutboundTestPlugin } from "../../test-utils/channel-plugins.js";
import {
  installMessageActionPolicy,
  resetMessageActionPolicyRegistry,
} from "./message-action-runner.authorization.test-helpers.js";
import { runMessageAction } from "./message-action-runner.js";

afterEach(() => {
  resetMessageActionPolicyRegistry();
});

describe("message action authorization context", () => {
  it("carries trusted parent conversation identity into message action policy", async () => {
    let seenContext: AuthorizationInvocationContext | undefined;
    installMessageActionPolicy((_, context) => {
      seenContext = context;
      return { effect: "deny", code: "thread-parent-denied" };
    });

    await expect(
      runMessageAction({
        cfg: {},
        action: "send",
        params: { channel: "slack", target: "C-thread", message: "hello" },
        dryRun: false,
        agentId: "molty",
        sessionKey: "agent:molty:slack:channel:C-parent:thread:C-thread",
        messageActionAuthorization: {
          requesterAccountId: "ops",
          requesterSenderId: "maintainer-1",
          requesterSenderIsOwner: false,
          requesterIsAuthorizedSender: true,
          requesterRoleIds: ["maintainers"],
          parentConversationId: "C-parent",
          toolContext: {
            currentChannelProvider: "slack",
            currentChannelId: "C-thread",
          },
        },
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(seenContext).toMatchObject({
      agentId: "molty",
      conversationId: "C-thread",
      parentConversationId: "C-parent",
    });
  });

  it("uses the capability envelope instead of ambient operator authorization", async () => {
    let seenContext: AuthorizationInvocationContext | undefined;
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    installMessageActionPolicy(
      (_request, context) => {
        seenContext = context;
        return { effect: "pass" };
      },
      createOutboundTestPlugin({
        id: "testchat",
        outbound: { deliveryMode: "direct", sendText },
      }),
    );

    await runMessageAction({
      cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:channel-1",
        message: "hello",
      },
      authorization: {
        principal: {
          kind: "operator",
          scopes: ["operator.admin"],
          isOwner: true,
        },
        agentId: "ambient-operator",
      },
      messageActionAuthorization: {
        requesterAccountId: "ops",
        requesterSenderId: "maintainer-1",
        requesterSenderIsOwner: false,
        requesterIsAuthorizedSender: true,
        requesterRoleIds: ["maintainers"],
        toolContext: {
          currentChannelProvider: "testchat",
          currentChannelId: "channel-1",
        },
      },
      sessionKey: "agent:molty:testchat:channel:channel-1",
      dryRun: false,
    });

    expect(seenContext).toMatchObject({
      principal: {
        kind: "sender",
        provider: "testchat",
        accountId: "ops",
        senderId: "maintainer-1",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers"],
      },
      agentId: "molty",
      sessionKey: "agent:molty:testchat:channel:channel-1",
      conversationId: "channel-1",
    });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("rejects capability authorization for another agent before policy or transport", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    const policy = vi.fn((_request, context: AuthorizationInvocationContext) =>
      context.agentId === "molty"
        ? ({ effect: "deny", code: "molty-denied" } as const)
        : ({ effect: "pass" } as const),
    );
    installMessageActionPolicy(
      policy,
      createOutboundTestPlugin({
        id: "testchat",
        outbound: { deliveryMode: "direct", sendText },
      }),
    );

    await expect(
      runMessageAction({
        cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        params: {
          channel: "testchat",
          target: "channel:channel-1",
          message: "hello",
        },
        agentId: "molty",
        sessionKey: "agent:molty:testchat:channel:channel-1",
        messageActionAuthorization: {
          authorization: {
            principal: {
              kind: "sender",
              provider: "testchat",
              senderId: "maintainer-1",
            },
            agentId: "other-agent",
            sessionKey: "agent:molty:testchat:channel:channel-1",
            conversationId: "channel-1",
          },
        },
        dryRun: false,
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(policy).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "top-level agent",
      envelope: false,
      authorization: { agentId: "other-agent" },
    },
    {
      name: "top-level normalized agent alias",
      envelope: false,
      authorization: { agentId: "!!!" },
    },
    {
      name: "top-level session key",
      envelope: false,
      authorization: { sessionKey: "agent:molty:testchat:channel:other" },
    },
    {
      name: "top-level session id",
      envelope: false,
      authorization: { sessionId: "session-other" },
    },
    {
      name: "capability session key",
      envelope: true,
      authorization: { sessionKey: "agent:molty:testchat:channel:other" },
    },
    {
      name: "capability session id",
      envelope: true,
      authorization: { sessionId: undefined },
    },
  ])("rejects a mismatched $name binding before policy or transport", async (testCase) => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    const policy = vi.fn(() => ({ effect: "pass" }) as const);
    installMessageActionPolicy(
      policy,
      createOutboundTestPlugin({
        id: "testchat",
        outbound: { deliveryMode: "direct", sendText },
      }),
    );
    const authorization: AuthorizationInvocationContext = {
      principal: { kind: "sender", provider: "testchat", senderId: "maintainer-1" },
      agentId: "molty",
      sessionKey: "agent:molty:testchat:channel:channel-1",
      sessionId: "session-1",
      conversationId: "channel-1",
      ...testCase.authorization,
    };

    await expect(
      runMessageAction({
        cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        params: { channel: "testchat", target: "channel:channel-1", message: "hello" },
        agentId: "molty",
        sessionKey: "agent:molty:testchat:channel:channel-1",
        sessionId: "session-1",
        ...(testCase.envelope
          ? { messageActionAuthorization: { authorization } }
          : { authorization }),
        dryRun: false,
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(policy).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("rejects a queued capability replay when execution agent identity is missing", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    const policy = vi.fn(() => ({ effect: "pass" }) as const);
    installMessageActionPolicy(
      policy,
      createOutboundTestPlugin({
        id: "testchat",
        outbound: { deliveryMode: "direct", sendText },
      }),
    );

    await expect(
      runMessageAction({
        cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        params: {
          channel: "testchat",
          target: "channel:channel-1",
          message: "hello",
        },
        messageActionAuthorization: {
          authorization: {
            principal: {
              kind: "sender",
              provider: "testchat",
              senderId: "maintainer-1",
            },
            agentId: "molty",
            conversationId: "channel-1",
          },
        },
        dryRun: false,
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(policy).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("uses canonical context fields while retaining anchored threading metadata", async () => {
    const canonicalSendText = vi.fn().mockResolvedValue({
      channel: "canonicalchat",
      messageId: "message-1",
      chatId: "channel:canonical",
    });
    const legacySendText = vi.fn().mockResolvedValue({
      channel: "legacychat",
      messageId: "message-2",
      chatId: "channel:legacy",
    });
    let seenAuthorization: AuthorizationInvocationContext | undefined;
    let seenToolContext: InternalChannelThreadingToolContext | undefined;
    const canonicalPlugin = {
      ...createOutboundTestPlugin({
        id: "canonicalchat",
        outbound: { deliveryMode: "direct", sendText: canonicalSendText },
      }),
      threading: {
        resolveAutoThreadId: ({
          toolContext,
        }: {
          toolContext?: InternalChannelThreadingToolContext;
        }) => {
          seenToolContext = toolContext;
          return toolContext?.currentThreadTs;
        },
      },
    };
    installMessageActionPolicy(
      (_request, context) => {
        seenAuthorization = context;
        return { effect: "pass" };
      },
      [
        canonicalPlugin,
        createOutboundTestPlugin({
          id: "legacychat",
          outbound: { deliveryMode: "direct", sendText: legacySendText },
        }),
      ],
    );
    const authorization: AuthorizationInvocationContext = {
      principal: {
        kind: "sender",
        provider: "canonicalchat",
        senderId: "maintainer-1",
      },
      agentId: "molty",
      sessionKey: "agent:molty:canonicalchat:channel:canonical",
      conversationId: "channel:canonical",
      parentConversationId: "parent:canonical",
      threadId: "thread:canonical",
    };

    await runMessageAction({
      cfg: {
        channels: {
          canonicalchat: { enabled: true },
          legacychat: { enabled: true },
        },
      } as OpenClawConfig,
      action: "send",
      params: { message: "hello" },
      agentId: "molty",
      sessionKey: authorization.sessionKey,
      messageActionAuthorization: {
        authorization,
        parentConversationId: "parent:legacy",
        toolContext: {
          currentChannelProvider: "legacychat",
          // A matching sibling must not prove unrelated alternate route ids.
          currentChannelId: "channel:canonical",
          currentMessagingTarget: "user:legacy",
          currentGraphChannelId: "graph:legacy",
          currentThreadTs: "thread:legacy",
          currentMessageId: "message-current",
          replyToMode: "all",
        },
      },
      dryRun: false,
    });

    expect(legacySendText).not.toHaveBeenCalled();
    expect(canonicalSendText).toHaveBeenCalledOnce();
    expect(canonicalSendText.mock.calls[0]?.[0]).toMatchObject({
      to: "channel:canonical",
      threadId: "thread:canonical",
    });
    expect(seenToolContext).toMatchObject({
      currentChannelProvider: "canonicalchat",
      currentChannelId: "channel:canonical",
      currentThreadTs: "thread:canonical",
      currentMessageId: "message-current",
      replyToMode: "all",
    });
    expect(seenToolContext?.currentMessagingTarget).toBeUndefined();
    expect(seenToolContext?.currentGraphChannelId).toBeUndefined();
    expect(seenAuthorization?.parentConversationId).toBe("parent:canonical");
  });

  it("does not reconstruct missing canonical route facts from legacy context", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    let seenToolContext: InternalChannelThreadingToolContext | undefined;
    const policy = vi.fn(() => ({ effect: "pass" }) as const);
    installMessageActionPolicy(policy, {
      ...createOutboundTestPlugin({
        id: "testchat",
        outbound: { deliveryMode: "direct", sendText },
      }),
      threading: {
        resolveAutoThreadId: ({
          toolContext,
        }: {
          toolContext?: InternalChannelThreadingToolContext;
        }) => {
          seenToolContext = toolContext;
          return toolContext?.currentThreadTs;
        },
      },
    });

    const result = await runMessageAction({
      cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:explicit",
        message: "hello",
      },
      agentId: "molty",
      messageActionAuthorization: {
        authorization: {
          principal: { kind: "sender", senderId: "maintainer-1" },
          agentId: "molty",
        },
        toolContext: {
          currentChannelProvider: "legacychat",
          currentChannelId: "channel:legacy",
          currentMessagingTarget: "user:legacy",
          currentGraphChannelId: "graph:legacy",
          currentThreadTs: "thread:legacy",
          currentChatType: "channel",
          currentMessageId: "message-current",
          currentSourceTurnId: "source-turn-current",
          replyToMode: "all",
        },
      },
      dryRun: true,
    });

    expect(result).toMatchObject({ kind: "send", channel: "testchat", dryRun: true });
    expect(sendText).not.toHaveBeenCalled();
    expect(policy).toHaveBeenCalledOnce();
    expect(seenToolContext).toMatchObject({
      currentChatType: "channel",
      currentMessageId: "message-current",
      currentSourceTurnId: "source-turn-current",
      replyToMode: "all",
    });
    expect(seenToolContext?.currentChannelProvider).toBeUndefined();
    expect(seenToolContext?.currentChannelId).toBeUndefined();
    expect(seenToolContext?.currentMessagingTarget).toBeUndefined();
    expect(seenToolContext?.currentGraphChannelId).toBeUndefined();
    expect(seenToolContext?.currentThreadTs).toBeUndefined();
  });
});
