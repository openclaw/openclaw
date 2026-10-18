import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  createGatewayActionPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
  readMockCallArg,
  readRecordField,
  createEnabledMessageActionConfig,
} from "./message-action-runner.test-helpers.js";

function registerGatewayPlugin(
  action: "send" | "react" | "poll" = "send",
  pluginId = "gatewaychat",
  options: Partial<
    Pick<Parameters<typeof createGatewayActionPlugin>[0], "capabilities" | "messaging">
  > = {},
) {
  const handleAction = vi.fn(async () => jsonResult({ ok: true, local: true }));
  setTestPlugin(
    createGatewayActionPlugin({
      pluginId,
      label: pluginId,
      blurb: "Gateway dispatch test plugin.",
      actions: [action],
      messaging: { targetResolver: { looksLikeId: () => true } },
      ...options,
      handleAction,
    }),
    pluginId,
  );
  return handleAction;
}

type ActionInput = Parameters<typeof runMessageAction>[0];
function runGatewayAction(
  action: ActionInput["action"],
  params: Record<string, unknown>,
  input: Omit<Partial<ActionInput>, "gateway"> & {
    gateway?: Partial<NonNullable<ActionInput["gateway"]>>;
  } = {},
) {
  return runMessageAction({
    cfg: createEnabledMessageActionConfig("gatewaychat"),
    action,
    params: { channel: "gatewaychat", ...params },
    dryRun: false,
    ...input,
    gateway: { clientName: "cli", mode: "cli", ...input.gateway },
  });
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(resetMessageActionRunnerMocks);
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });
  it("routes gateway-executed plugin actions through gateway RPC instead of local dispatch", async () => {
    const looksLikeId = vi.fn(() => true);
    const handleActionEntry = registerGatewayPlugin("react", "gatewaychat", {
      capabilities: { chatTypes: ["direct"], reactions: true },
      messaging: { targetResolver: { looksLikeId } },
    });
    mocks.callGatewayLeastPrivilege.mockResolvedValue({
      ok: true,
      added: "✅",
    });

    const resolveAgentRuntimeIdentityToken = vi.fn(async () => "agent-runtime-token");
    const result = await runGatewayAction(
      "react",
      {
        to: "+15551234567",
        chatJid: "+15551234567",
        messageId: "wamid.1",
        emoji: "✅",
      },
      {
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:main",
        sessionId: "session-123",
        agentId: "alpha",
        inboundEventKind: "room_event",
        toolContext: {
          currentChannelProvider: "gatewaychat",
          currentMessageId: "wamid.1",
        },
        gateway: { resolveAgentRuntimeIdentityToken },
      },
    );

    const gatewayCall = readMockCallArg(
      mocks.callGatewayLeastPrivilege,
      "gateway least privilege call",
    );
    expect(gatewayCall).toMatchObject({ method: "message.action" });
    expect(gatewayCall.agentRuntimeIdentityToken).toBe("agent-runtime-token");
    expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledTimes(1);
    const gatewayParams = readRecordField(gatewayCall, "params", "gateway call params");
    expect(gatewayParams).not.toHaveProperty("conversationReadOrigin");
    expect(gatewayParams).toMatchObject({
      channel: "gatewaychat",
      action: "react",
      sessionKey: "agent:alpha:main",
      sessionId: "session-123",
      agentId: "alpha",
      inboundTurnKind: "room_event",
      idempotencyKey: "idem-gateway-action",
    });
    expect(gatewayParams).not.toHaveProperty("requesterAccountId");
    expect(gatewayParams).not.toHaveProperty("requesterSenderId");
    expect(gatewayParams).not.toHaveProperty("toolContext");
    expect(looksLikeId).not.toHaveBeenCalled();
    expect(handleActionEntry).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "action",
      channel: "gatewaychat",
      action: "react",
      handledBy: "plugin",
    });
    expect(readRecordField(result, "payload", "result payload")).toMatchObject({
      ok: true,
      added: "✅",
    });
  });

  it("routes gateway-executed plugin sends through gateway RPC instead of local dispatch", async () => {
    const handleActionResult = registerGatewayPlugin();
    mocks.callGatewayLeastPrivilege.mockResolvedValue({
      ok: true,
      messageId: "gw-send-1",
    });
    const resolveAgentRuntimeIdentityToken = vi.fn(async () => "test-token-placeholder");

    const result = await runGatewayAction(
      "send",
      {
        target: "user-123",
        message: "hello from cli",
      },
      {
        conversationReadOrigin: "direct-operator",
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplyFinal: true,

        toolContext: {
          currentChannelProvider: "gatewaychat",
          currentMessagingTarget: "user-123",
          currentMessageId: "source-message-1",
          replyToMode: "first",
        },
        gateway: { resolveAgentRuntimeIdentityToken },
      },
    );

    const gatewayCall = readMockCallArg(
      mocks.callGatewayLeastPrivilege,
      "gateway least privilege call",
    );
    expect(gatewayCall).toMatchObject({ method: "message.action" });
    const gatewayParams = readRecordField(gatewayCall, "params", "gateway call params");
    expect(gatewayParams).toEqual(
      expect.objectContaining({
        channel: "gatewaychat",
        action: "send",
        conversationReadOrigin: "direct-operator",
        idempotencyKey: "idem-gateway-action",
        reply: {
          replyToId: "source-message-1",
          source: "implicit",
          mode: "first",
        },
      }),
    );
    expect(gatewayParams).not.toHaveProperty("sourceReplyFinal");
    expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledWith({
      sourceReplyFinal: true,
    });
    expect(readRecordField(gatewayParams, "params", "gateway message params")).toMatchObject({
      to: "user-123",
      message: "hello from cli",
    });
    expect(mocks.executeSendAction).not.toHaveBeenCalled();
    expect(handleActionResult).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "send",
      channel: "gatewaychat",
      action: "send",
      handledBy: "plugin",
    });
    expect(readRecordField(result, "payload", "result payload")).toMatchObject({
      ok: true,
      messageId: "gw-send-1",
    });
  });

  it("makes required queue persistence bypass gateway plugin dispatch", async () => {
    registerGatewayPlugin();
    mocks.executeSendAction.mockResolvedValueOnce({
      handledBy: "core",
      payload: { ok: true, messageId: "core-send-1" },
      sendResult: {
        channel: "gatewaychat",
        to: "user-123",
        via: "direct",
        mediaUrl: null,
      },
    });

    const result = await runGatewayAction(
      "send",
      {
        target: "user-123",
        message: "durable hello",
      },
      {
        requireQueuePersistence: true,
      },
    );

    expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    const executeCall = readMockCallArg(mocks.executeSendAction, "execute send call");
    const context = readRecordField(executeCall, "ctx", "execute send context");
    expect(readRecordField(context, "input", "message action input")).toMatchObject({
      requireQueuePersistence: true,
    });
    expect(result).toMatchObject({ handledBy: "core" });
  });
  it("routes gateway-executed plugin polls through gateway RPC instead of local dispatch", async () => {
    const handleActionLocal = registerGatewayPlugin("poll", "pollchat");
    mocks.callGatewayLeastPrivilege.mockResolvedValue({
      ok: true,
      pollId: "gw-poll-1",
    });

    const result = await runGatewayAction(
      "poll",
      {
        channel: "pollchat",
        target: "pollchat:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
      },
      {
        cfg: { channels: { pollchat: { botToken: "tok" } } } as OpenClawConfig,
      },
    );

    const gatewayCall = readMockCallArg(
      mocks.callGatewayLeastPrivilege,
      "gateway least privilege call",
    );
    expect(gatewayCall).toMatchObject({ method: "message.action" });
    const gatewayParams = readRecordField(gatewayCall, "params", "gateway call params");
    expect(gatewayParams).toMatchObject({
      channel: "pollchat",
      action: "poll",
      idempotencyKey: "idem-gateway-action",
    });
    expect(readRecordField(gatewayParams, "params", "gateway poll params")).toEqual(
      expect.objectContaining({
        to: "pollchat:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
      }),
    );
    expect(mocks.executePollAction).not.toHaveBeenCalled();
    expect(handleActionLocal).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "poll",
      channel: "pollchat",
      action: "poll",
      handledBy: "plugin",
    });
    expect(readRecordField(result, "payload", "result payload")).toMatchObject({
      ok: true,
      pollId: "gw-poll-1",
    });
  });
});
