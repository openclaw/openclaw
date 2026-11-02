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

type ActionInput = Parameters<typeof runMessageAction>[0];
type GatewayAction = "send" | "react" | "poll";
function runGatewayAction(
  action: GatewayAction,
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

describe("runMessageAction gateway dispatch", () => {
  beforeEach(resetMessageActionRunnerMocks);
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["react", "send", "poll"] as const)(
    "routes gateway-executed %s through RPC instead of local dispatch",
    async (action) => {
      const channel = action === "poll" ? "pollchat" : "gatewaychat";
      const looksLikeId = vi.fn(() => true);
      const handleAction = vi.fn(async () => jsonResult({ ok: true, local: true }));
      setTestPlugin(
        createGatewayActionPlugin({
          pluginId: channel,
          label: channel,
          blurb: "Gateway dispatch test plugin.",
          actions: [action],
          ...(action === "react"
            ? { capabilities: { chatTypes: ["direct"], reactions: true } }
            : {}),
          messaging: { targetResolver: { looksLikeId } },
          handleAction,
        }),
        channel,
      );
      const payload =
        action === "react"
          ? { ok: true, added: "✅" }
          : action === "send"
            ? { ok: true, messageId: "gw-send-1" }
            : { ok: true, pollId: "gw-poll-1" };
      mocks.callGatewayLeastPrivilege.mockResolvedValue({ ...payload });
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => "agent-runtime-token");
      const params =
        action === "react"
          ? { to: "+15551234567", chatJid: "+15551234567", messageId: "wamid.1", emoji: "✅" }
          : action === "send"
            ? { target: "user-123", message: "hello from cli" }
            : { target: "pollchat:123", pollQuestion: "Lunch?", pollOption: ["Pizza", "Sushi"] };
      const result = await runGatewayAction(
        action,
        { channel, ...params },
        {
          cfg:
            action === "poll"
              ? ({ channels: { pollchat: { botToken: "tok" } } } as OpenClawConfig)
              : createEnabledMessageActionConfig(channel),
          ...(action === "react"
            ? {
                requesterSenderId: "trusted-user",
                sessionKey: "agent:alpha:main",
                sessionId: "session-123",
                agentId: "alpha",
                inboundEventKind: "room_event",
                toolContext: { currentChannelProvider: channel, currentMessageId: "wamid.1" },
              }
            : action === "send"
              ? {
                  conversationReadOrigin: "direct-operator",
                  sourceReplyDeliveryMode: "message_tool_only",
                  sourceReplyFinal: true,
                  toolContext: {
                    currentChannelProvider: channel,
                    currentMessagingTarget: "user-123",
                    currentMessageId: "source-message-1",
                    replyToMode: "first",
                  },
                }
              : {}),
          gateway: action === "poll" ? {} : { resolveAgentRuntimeIdentityToken },
        },
      );
      const call = readMockCallArg(mocks.callGatewayLeastPrivilege, "gateway call");
      const rpc = readRecordField(call, "params", "gateway params");
      expect(call).toMatchObject({ method: "message.action" });
      expect(rpc).toMatchObject({ channel, action, idempotencyKey: "idem-gateway-action" });
      expect(handleAction).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        kind: action === "react" ? "action" : action,
        channel,
        action,
        handledBy: "plugin",
        payload,
      });
      if (action === "react") {
        expect(call.agentRuntimeIdentityToken).toBe("agent-runtime-token");
        expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledOnce();
        expect(rpc).toMatchObject({
          sessionKey: "agent:alpha:main",
          sessionId: "session-123",
          agentId: "alpha",
          inboundTurnKind: "room_event",
        });
        for (const key of [
          "conversationReadOrigin",
          "requesterAccountId",
          "requesterSenderId",
          "toolContext",
        ]) {
          expect(rpc).not.toHaveProperty(key);
        }
        expect(looksLikeId).not.toHaveBeenCalled();
      } else if (action === "send") {
        expect(rpc).toMatchObject({
          conversationReadOrigin: "direct-operator",
          reply: { replyToId: "source-message-1", source: "implicit", mode: "first" },
          params: { to: "user-123", message: "hello from cli" },
        });
        expect(rpc).not.toHaveProperty("sourceReplyFinal");
        expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledWith({ sourceReplyFinal: true });
        expect(mocks.executeSendAction).not.toHaveBeenCalled();
      } else {
        expect(rpc).toMatchObject({
          params: { to: "pollchat:123", pollQuestion: "Lunch?", pollOption: ["Pizza", "Sushi"] },
        });
        expect(mocks.executePollAction).not.toHaveBeenCalled();
      }
    },
  );

  it("makes required queue persistence bypass gateway plugin dispatch", async () => {
    setTestPlugin(
      createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "gatewaychat",
        blurb: "Gateway dispatch test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: async () => jsonResult({ ok: true, local: true }),
      }),
      "gatewaychat",
    );
    mocks.executeSendAction.mockResolvedValueOnce({
      handledBy: "core",
      payload: { ok: true, messageId: "core-send-1" },
      sendResult: { channel: "gatewaychat", to: "user-123", via: "direct", mediaUrl: null },
    });
    const result = await runGatewayAction(
      "send",
      { target: "user-123", message: "durable hello" },
      {
        requireQueuePersistence: true,
      },
    );
    expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    expect(readMockCallArg(mocks.executeSendAction, "execute send call")).toMatchObject({
      ctx: { input: { requireQueuePersistence: true } },
    });
    expect(result).toMatchObject({ handledBy: "core" });
  });
});
