// Covers the canonical authorization snapshot and the final local message-effect gate.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthorizationInvocationContext } from "../../plugins/authorization-policy.types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferred } from "../../shared/deferred.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  installMessageActionPolicy,
  resetMessageActionPolicyRegistry,
} from "./message-action-runner.authorization.test-helpers.js";
import { authorizePreparedMessageAction, runMessageAction } from "./message-action-runner.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayLeastPrivilege: vi.fn(),
  isGatewayTransportError: vi.fn<(value: unknown) => boolean>(() => false),
}));

vi.mock("./message.gateway.runtime.js", () => ({
  callGatewayLeastPrivilege: gatewayMocks.callGatewayLeastPrivilege,
  isGatewayTransportError: gatewayMocks.isGatewayTransportError,
  randomIdempotencyKey: () => "broadcast-idempotency-key",
}));

const senderAuthorization: AuthorizationInvocationContext = {
  principal: {
    kind: "sender",
    provider: "slack",
    accountId: "ops",
    senderId: "maintainer-1",
    senderIsOwner: false,
    isAuthorizedSender: true,
    roleIds: ["maintainers"],
  },
  agentId: "main",
  sessionKey: "agent:main:slack:channel:C123",
  sessionId: "session-1",
  conversationId: "C123",
  threadId: "1712345.0001",
};

afterEach(() => {
  resetMessageActionPolicyRegistry();
  gatewayMocks.callGatewayLeastPrivilege.mockReset();
  gatewayMocks.isGatewayTransportError.mockReset();
  gatewayMocks.isGatewayTransportError.mockReturnValue(false);
});

describe("message action authorization", () => {
  it("passes a canonical immutable snapshot without raw attachment bytes", async () => {
    let seenRequest: unknown;
    let seenContext: unknown;
    installMessageActionPolicy((request, context) => {
      seenRequest = request;
      seenContext = context;
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.input)).toBe(true);
      return { effect: "pass" };
    });

    await authorizePreparedMessageAction({
      cfg: {},
      action: "send",
      channel: "slack",
      accountId: " ops ",
      target: " C123 ",
      threadId: "1712345.0001",
      dryRun: false,
      input: {
        channel: "slack",
        to: "C123",
        message: "hello",
        buffer: "cHJpdmF0ZS1hdHRhY2htZW50",
        omitted: undefined,
      },
      authorization: senderAuthorization,
    });

    expect(seenRequest).toMatchObject({
      operation: "message.action",
      action: "send",
      channel: "slack",
      accountId: "ops",
      target: "C123",
      threadId: "1712345.0001",
      dryRun: false,
      input: {
        channel: "slack",
        to: "C123",
        message: "hello",
        buffer: { encoding: "base64", encodedLength: 24 },
      },
    });
    expect(seenRequest).not.toHaveProperty("input.omitted");
    expect(JSON.stringify(seenRequest)).not.toContain("cHJpdmF0ZS1hdHRhY2htZW50");
    expect(seenContext).toEqual(senderAuthorization);
  });

  it("preserves an own __proto__ value from policy snapshot through execution", async () => {
    const sendPayload = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    const providerData = JSON.parse('{"__proto__":{"mode":"strict"}}') as Record<string, unknown>;
    let authorizedProviderData: Record<string, unknown> | undefined;
    installMessageActionPolicy(
      (request) => {
        const payload = request.input.payload;
        const channelData =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? payload.channelData
            : undefined;
        authorizedProviderData =
          channelData && typeof channelData === "object" && !Array.isArray(channelData)
            ? (channelData.testchat as Record<string, unknown>)
            : undefined;
        return { effect: "pass" };
      },
      createOutboundTestPlugin({
        id: "testchat",
        outbound: {
          deliveryMode: "direct",
          sendText: vi.fn(),
          sendPayload,
        },
      }),
    );

    await runMessageAction({
      cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:channel-1",
        message: "hello",
        channelData: { testchat: providerData },
      },
      dryRun: false,
      agentId: "main",
    });

    const executedContext = sendPayload.mock.calls[0]?.[0] as
      | { payload?: { channelData?: Record<string, unknown> } }
      | undefined;
    const executedProviderData = executedContext?.payload?.channelData?.testchat as
      | Record<string, unknown>
      | undefined;
    expect(Object.hasOwn(authorizedProviderData ?? {}, "__proto__")).toBe(true);
    expect(Object.hasOwn(executedProviderData ?? {}, "__proto__")).toBe(true);
    const authorizedProto = authorizedProviderData
      ? Object.getOwnPropertyDescriptor(authorizedProviderData, "__proto__")?.value
      : undefined;
    const executedProto = executedProviderData
      ? Object.getOwnPropertyDescriptor(executedProviderData, "__proto__")?.value
      : undefined;
    expect(authorizedProto).toEqual(executedProto);
    expect(JSON.stringify(authorizedProviderData)).toBe(JSON.stringify(executedProviderData));
  });

  it("rejects accessor-backed input without invoking the accessor or policy", async () => {
    const getter = vi.fn(() => "private");
    const input: Record<string, unknown> = { channel: "slack", message: "hello" };
    Object.defineProperty(input, "token", { enumerable: true, get: getter });
    const policy = vi.fn(() => ({ effect: "pass" as const }));
    installMessageActionPolicy(policy);

    await expect(
      authorizePreparedMessageAction({
        cfg: {},
        action: "send",
        channel: "slack",
        target: "C123",
        dryRun: false,
        input,
        authorization: senderAuthorization,
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");
    expect(getter).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
  });

  it("dispatches the detached snapshot when caller data mutates during authorization", async () => {
    const policyEntered = createDeferred();
    const releasePolicy = createDeferred();
    const sendPayload = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    installMessageActionPolicy(
      async () => {
        policyEntered.resolve();
        await releasePolicy.promise;
        return { effect: "pass" };
      },
      createOutboundTestPlugin({
        id: "testchat",
        outbound: {
          deliveryMode: "direct",
          sendText: vi.fn(),
          sendPayload,
        },
      }),
    );
    const channelData = { testchat: { marker: "before" } };
    const actionParams = {
      channel: "testchat",
      target: "channel:channel-1",
      message: "hello",
      channelData,
    };

    const pending = runMessageAction({
      cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
      action: "send",
      params: actionParams,
      dryRun: false,
      agentId: "main",
    });
    await policyEntered.promise;
    channelData.testchat.marker = "after";
    releasePolicy.resolve();
    await pending;

    expect(sendPayload).toHaveBeenCalledOnce();
    expect(sendPayload.mock.calls[0]?.[0]).toMatchObject({
      payload: { channelData: { testchat: { marker: "before" } } },
    });
  });

  it("blocks a denied local send before transport dispatch", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    installMessageActionPolicy(
      () => ({ effect: "deny", code: "maintainer-required" }),
      createOutboundTestPlugin({
        id: "testchat",
        outbound: { deliveryMode: "direct", sendText },
      }),
    );
    const cfg = {
      channels: { testchat: { enabled: true } },
    } as OpenClawConfig;

    await expect(
      runMessageAction({
        cfg,
        action: "send",
        params: { channel: "testchat", target: "channel:channel-1", message: "hello" },
        dryRun: false,
        agentId: "main",
        sessionKey: "agent:main:testchat:channel:channel-1",
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
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("blocks normalized send fields before core delivery", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    let seenInput: Record<string, unknown> | undefined;
    installMessageActionPolicy(
      (request) => {
        seenInput = request.input;
        return request.input.forceDocument === true && request.input.asVoice === true
          ? { effect: "deny", code: "normalized-send-blocked" }
          : { effect: "pass" };
      },
      createOutboundTestPlugin({
        id: "testchat",
        outbound: { deliveryMode: "direct", sendText },
      }),
    );
    const cfg = {
      channels: { testchat: { enabled: true } },
    } as OpenClawConfig;

    await expect(
      runMessageAction({
        cfg,
        action: "send",
        params: {
          channel: "testchat",
          target: "channel:channel-1",
          message: "[[audio_as_voice]]hello",
          asDocument: true,
          gifPlayback: true,
          silent: true,
        },
        dryRun: false,
        agentId: "main",
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(seenInput).toMatchObject({
      message: "hello",
      payload: {
        text: "hello",
        audioAsVoice: true,
      },
      asVoice: true,
      audioAsVoice: true,
      gifPlayback: true,
      forceDocument: true,
      silent: true,
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("authorizes channel-prepared payloads before the transport effect", async () => {
    const sendPayload = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    const channelPlugin = {
      ...createOutboundTestPlugin({
        id: "testchat",
        outbound: {
          deliveryMode: "direct",
          sendText: vi.fn().mockResolvedValue({ channel: "testchat", messageId: "message-1" }),
          sendPayload,
        },
      }),
      actions: {
        describeMessageTool: () => ({ actions: ["send"] as const }),
        prepareSendPayload: ({ payload }: { payload: Record<string, unknown> }) => ({
          ...payload,
          channelData: { testchat: { prepared: true } },
        }),
      },
    };
    installMessageActionPolicy(
      (request) =>
        request.input.payload &&
        typeof request.input.payload === "object" &&
        !Array.isArray(request.input.payload) &&
        request.input.payload.channelData
          ? { effect: "deny", code: "prepared-payload-blocked" }
          : { effect: "pass" },
      channelPlugin,
    );
    const cfg = {
      channels: { testchat: { enabled: true } },
    } as OpenClawConfig;

    await expect(
      runMessageAction({
        cfg,
        action: "send",
        params: {
          channel: "testchat",
          target: "channel:channel-1",
          message: "hello",
        },
        dryRun: false,
        agentId: "main",
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");
    expect(sendPayload).not.toHaveBeenCalled();
  });

  it("keeps prepared media and voice aliases consistent with the policy payload", async () => {
    const sendPayload = vi.fn();
    let seenInput: Record<string, unknown> | undefined;
    const channelPlugin = {
      ...createOutboundTestPlugin({
        id: "testchat",
        outbound: {
          deliveryMode: "direct",
          sendText: vi.fn(),
          sendPayload,
        },
      }),
      actions: {
        describeMessageTool: () => ({ actions: ["send"] as const }),
        prepareSendPayload: ({ payload }: { payload: Record<string, unknown> }) => ({
          ...payload,
          mediaUrls: ["https://example.test/one.ogg", "https://example.test/two.ogg"],
          audioAsVoice: true,
        }),
      },
    };
    installMessageActionPolicy((request) => {
      seenInput = request.input;
      return request.input.audioAsVoice === true
        ? { effect: "deny", code: "prepared-voice-blocked" }
        : { effect: "pass" };
    }, channelPlugin);

    await expect(
      runMessageAction({
        cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        params: {
          channel: "testchat",
          target: "channel:channel-1",
          message: "hello",
        },
        dryRun: false,
        agentId: "main",
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(seenInput).toMatchObject({
      payload: {
        mediaUrls: ["https://example.test/one.ogg", "https://example.test/two.ogg"],
        audioAsVoice: true,
      },
      media: "https://example.test/one.ogg",
      mediaUrl: "https://example.test/one.ogg",
      mediaUrls: ["https://example.test/one.ogg", "https://example.test/two.ogg"],
      asVoice: true,
      audioAsVoice: true,
    });
    expect(sendPayload).not.toHaveBeenCalled();
  });

  it("surfaces the stable policy denial when final channel normalization changes payload", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    let finalInput: Record<string, unknown> | undefined;
    installMessageActionPolicy(
      (request) => {
        const payload = request.input.payload;
        const isFinal =
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          typeof payload.text === "string" &&
          payload.text.endsWith(":post-hook");
        if (isFinal) {
          finalInput = request.input;
        }
        return isFinal ? { effect: "deny", code: "final-payload-denied" } : { effect: "pass" };
      },
      createOutboundTestPlugin({
        id: "testchat",
        outbound: {
          deliveryMode: "direct",
          normalizePayload: ({ payload }) => {
            const { channelData: _channelData, ...finalPayload } = payload;
            return {
              ...finalPayload,
              text: `${payload.text}:post-hook`,
            };
          },
          sendText,
        },
      }),
    );

    await expect(
      runMessageAction({
        cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        params: {
          channel: "testchat",
          target: "channel:one",
          message: "hello",
          channelData: { testchat: { stale: true } },
        },
        dryRun: false,
        agentId: "main",
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");
    expect(finalInput).not.toHaveProperty("channelData");
    expect(finalInput?.payload).not.toHaveProperty("channelData");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("denies a changed second broadcast leaf after every leaf arrives and sends nothing", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    const finalAuthorizationTargets: string[] = [];
    installMessageActionPolicy(
      (request) => {
        if (request.action !== "send") {
          return { effect: "pass" };
        }
        const payload = request.input.payload;
        const isFinalPayload =
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          typeof payload.text === "string" &&
          payload.text.endsWith(":post-hook");
        if (!isFinalPayload) {
          return { effect: "pass" };
        }
        finalAuthorizationTargets.push(request.target ?? "");
        return request.target?.endsWith("two")
          ? { effect: "deny", code: "second-final-leaf-denied" }
          : { effect: "pass" };
      },
      createOutboundTestPlugin({
        id: "testchat",
        outbound: {
          deliveryMode: "direct",
          normalizePayload: ({ payload }) => ({
            ...payload,
            text: `${payload.text}:post-hook`,
          }),
          sendText,
        },
      }),
    );
    const cfg = {
      channels: { testchat: { enabled: true } },
    } as OpenClawConfig;

    await expect(
      runMessageAction({
        cfg,
        action: "broadcast",
        params: {
          channel: "testchat",
          targets: ["channel:one", "channel:two"],
          message: "hello",
        },
        dryRun: false,
        agentId: "main",
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");
    expect(finalAuthorizationTargets).toHaveLength(2);
    expect(finalAuthorizationTargets.some((target) => target.endsWith("one"))).toBe(true);
    expect(finalAuthorizationTargets.some((target) => target.endsWith("two"))).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("keeps target-resolution failures in broadcast results while sending valid leaves", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    const plugin = createOutboundTestPlugin({
      id: "testchat",
      outbound: { deliveryMode: "direct", sendText },
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));

    const result = await runMessageAction({
      cfg: {
        channels: { testchat: { enabled: true } },
        tools: { message: { broadcast: { enabled: true } } },
      } as OpenClawConfig,
      action: "broadcast",
      params: {
        channel: "testchat",
        targets: ["channel:one", "none"],
        message: "hello",
      },
      dryRun: false,
      agentId: "main",
    });

    expect(result).toMatchObject({
      kind: "broadcast",
      payload: {
        results: [
          { channel: "testchat", to: expect.stringContaining("one"), ok: true },
          { channel: "testchat", to: "none", ok: false },
        ],
      },
    });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("keeps ordinary pre-dispatch failures per leaf while sending valid broadcast leaves", async () => {
    const configured = (plugin: ReturnType<typeof createOutboundTestPlugin>) => ({
      ...plugin,
      config: { ...plugin.config, listAccountIds: () => ["default"] },
    });
    const sendText = vi.fn().mockResolvedValue({
      channel: "goodchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    const rejectedSendText = vi.fn();
    const goodPlugin = configured(
      createOutboundTestPlugin({
        id: "goodchat",
        outbound: { deliveryMode: "direct", sendText },
      }),
    );
    const rejectedPlugin = configured(
      createOutboundTestPlugin({
        id: "rejectedchat",
        outbound: {
          deliveryMode: "direct",
          normalizePayload: () => {
            throw new Error("rejected leaf preparation");
          },
          sendText: rejectedSendText,
        },
      }),
    );
    setActivePluginRegistry(
      createTestRegistry(
        [goodPlugin, rejectedPlugin].map((plugin) => ({
          pluginId: plugin.id,
          source: "test",
          plugin,
        })),
      ),
    );

    const result = await runMessageAction({
      cfg: {
        channels: {
          goodchat: { enabled: true },
          rejectedchat: { enabled: true },
        },
        tools: { message: { broadcast: { enabled: true } } },
      } as OpenClawConfig,
      action: "broadcast",
      params: { targets: ["channel:one"], message: "hello" },
      dryRun: false,
      agentId: "main",
    });

    expect(result).toMatchObject({
      kind: "broadcast",
      payload: {
        results: expect.arrayContaining([
          expect.objectContaining({ channel: "goodchat", ok: true }),
          expect.objectContaining({
            channel: "rejectedchat",
            ok: false,
            error: "rejected leaf preparation",
          }),
        ]),
      },
    });
    expect(sendText).toHaveBeenCalledOnce();
    expect(rejectedSendText).not.toHaveBeenCalled();
  });

  it("keeps nested broadcast dry-runs local and side-effect free", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "directchat",
      messageId: "must-not-send",
      chatId: "channel-1",
    });
    const configured = (plugin: ReturnType<typeof createOutboundTestPlugin>) => ({
      ...plugin,
      config: { ...plugin.config, listAccountIds: () => ["default"] },
    });
    setActivePluginRegistry(
      createTestRegistry(
        [
          configured(
            createOutboundTestPlugin({
              id: "directchat",
              outbound: { deliveryMode: "direct", sendText },
            }),
          ),
          configured(
            createOutboundTestPlugin({
              id: "gatewaychat",
              outbound: { deliveryMode: "gateway" },
            }),
          ),
        ].map((plugin) => ({ pluginId: plugin.id, source: "test", plugin })),
      ),
    );
    const cfg = {
      channels: {
        directchat: { enabled: true },
        gatewaychat: { enabled: true },
      },
      tools: { message: { broadcast: { enabled: true } } },
    } as OpenClawConfig;

    const result = await runMessageAction({
      cfg,
      action: "broadcast",
      params: { targets: ["channel:one"], message: "hello", dryRun: true },
      agentId: "main",
    });

    expect(result).toMatchObject({
      kind: "broadcast",
      handledBy: "dry-run",
      dryRun: true,
      payload: {
        results: [
          { channel: "directchat", ok: true },
          { channel: "gatewaychat", ok: true },
        ],
      },
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
  });

  it("preserves mixed direct and gateway-core broadcasts when a policy passes", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "directchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    const configured = (plugin: ReturnType<typeof createOutboundTestPlugin>) => ({
      ...plugin,
      config: { ...plugin.config, listAccountIds: () => ["default"] },
    });
    installMessageActionPolicy(
      () => ({ effect: "pass" }),
      [
        configured(
          createOutboundTestPlugin({
            id: "directchat",
            outbound: { deliveryMode: "direct", sendText },
          }),
        ),
        configured(
          createOutboundTestPlugin({
            id: "gatewaychat",
            outbound: { deliveryMode: "gateway" },
          }),
        ),
      ],
    );
    const cfg = {
      channels: {
        directchat: { enabled: true },
        gatewaychat: { enabled: true },
      },
      tools: { message: { broadcast: { enabled: true } } },
    } as OpenClawConfig;
    gatewayMocks.callGatewayLeastPrivilege.mockResolvedValue({
      results: [
        { channel: "directchat", to: "channel:one", ok: true },
        { channel: "gatewaychat", to: "channel:one", ok: true },
      ],
    });
    const resolveAgentRuntimeIdentityToken = vi.fn(async () => "test-token-placeholder");

    const result = await runMessageAction({
      cfg,
      action: "broadcast",
      params: { targets: ["channel:one"], message: "hello" },
      dryRun: false,
      agentId: "main",
      sessionKey: senderAuthorization.sessionKey,
      sessionId: senderAuthorization.sessionId,
      authorization: senderAuthorization,
      gateway: {
        resolveAgentRuntimeIdentityToken,
        clientName: "cli",
        mode: "cli",
      },
    });

    expect(result).toMatchObject({ kind: "broadcast" });
    expect(sendText).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
    const gatewayCall = gatewayMocks.callGatewayLeastPrivilege.mock.calls[0]?.[0];
    expect(gatewayCall?.agentRuntimeIdentityToken).toBe("test-token-placeholder");
    expect(gatewayCall?.params).toEqual(
      expect.objectContaining({
        action: "broadcast",
        sessionKey: senderAuthorization.sessionKey,
        sessionId: senderAuthorization.sessionId,
      }),
    );
  });

  it("fails closed before delegation when a sender broadcast lacks signed runtime identity", async () => {
    const sendText = vi.fn();
    const plugin = createOutboundTestPlugin({
      id: "gatewaychat",
      outbound: { deliveryMode: "gateway", sendText },
    });
    installMessageActionPolicy(() => ({ effect: "pass" }), {
      ...plugin,
      config: { ...plugin.config, listAccountIds: () => ["default"] },
    });

    await expect(
      runMessageAction({
        cfg: {
          channels: { gatewaychat: { enabled: true } },
          tools: { message: { broadcast: { enabled: true } } },
        } as OpenClawConfig,
        action: "broadcast",
        params: { targets: ["channel:one"], message: "hello" },
        agentId: "main",
        sessionKey: senderAuthorization.sessionKey,
        authorization: senderAuthorization,
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(sendText).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
  });

  it("keeps every Gateway-owned broadcast leaf unsent when one final payload is denied", async () => {
    const directSend = vi.fn().mockResolvedValue({ messageId: "direct-message" });
    const gatewaySend = vi.fn().mockResolvedValue({ messageId: "gateway-message" });
    const configured = (plugin: ReturnType<typeof createOutboundTestPlugin>) => ({
      ...plugin,
      config: { ...plugin.config, listAccountIds: () => ["default"] },
    });
    installMessageActionPolicy(
      (request) => {
        const payload = request.input.payload;
        return payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          payload.text === "forbidden-final"
          ? { effect: "deny", code: "remote-final-denied" }
          : { effect: "pass" };
      },
      [
        configured(
          createOutboundTestPlugin({
            id: "directchat",
            outbound: { deliveryMode: "direct", sendText: directSend },
          }),
        ),
        configured(
          createOutboundTestPlugin({
            id: "gatewaychat",
            outbound: {
              deliveryMode: "gateway",
              normalizePayload: ({ payload }) => ({ ...payload, text: "forbidden-final" }),
              sendText: gatewaySend,
            },
          }),
        ),
      ],
    );
    const cfg = {
      channels: {
        directchat: { enabled: true },
        gatewaychat: { enabled: true },
      },
      tools: { message: { broadcast: { enabled: true } } },
    } as OpenClawConfig;
    const broadcastAuthorization: AuthorizationInvocationContext = {
      ...senderAuthorization,
      principal: { kind: "operator", scopes: ["operator.write"] },
    };
    gatewayMocks.callGatewayLeastPrivilege.mockImplementation(
      async (call: { params?: Record<string, unknown> }) => {
        const request = call.params as {
          params: Record<string, unknown>;
          sessionKey?: string;
          sessionId?: string;
          agentId?: string;
        };
        const remote = await runMessageAction({
          cfg,
          action: "broadcast",
          params: request.params,
          agentId: request.agentId,
          sessionKey: request.sessionKey,
          sessionId: request.sessionId,
          authorization: broadcastAuthorization,
          gatewayOwnedDelivery: true,
        });
        return remote.kind === "broadcast" ? remote.payload : undefined;
      },
    );
    const resolveAgentRuntimeIdentityToken = vi.fn(async () => "test-token-placeholder");

    await expect(
      runMessageAction({
        cfg,
        action: "broadcast",
        params: { targets: ["channel:one"], message: "hello" },
        agentId: "main",
        sessionKey: senderAuthorization.sessionKey,
        sessionId: senderAuthorization.sessionId,
        authorization: broadcastAuthorization,
        gateway: {
          resolveAgentRuntimeIdentityToken,
          clientName: "cli",
          mode: "cli",
        },
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(directSend).not.toHaveBeenCalled();
    expect(gatewaySend).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
  });
});
