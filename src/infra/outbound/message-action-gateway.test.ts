import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createMessageMethodTestDriver,
  makeContext,
} from "../../gateway/server-methods/send.test-support.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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

  it.each([
    { scheduled: false, scopes: [] },
    { scheduled: false, scopes: ["operator.write"] },
    { scheduled: false, scopes: ["operator.admin"] },
    { scheduled: true, scopes: ["operator.write"] },
  ])(
    "preserves namespace intent, recipient, and caller scopes (scheduled=$scheduled, scopes=$scopes)",
    async ({ scheduled, scopes }) => {
      await withOpenClawTestState({ prefix: "gateway-namespace-provenance-" }, async () => {
        const handleAction = vi.fn(async () => jsonResult({ ok: true }));
        const plugin = createGatewayActionPlugin({
          pluginId: "gatewaychat",
          label: "Gateway Chat",
          blurb: "Gateway namespace test plugin.",
          actions: ["edit"],
          messaging: {
            targetPrefixes: ["g"],
            normalizeTarget: (raw) => (raw.startsWith("@") ? raw : `@${raw}`),
            targetResolver: { looksLikeId: () => true },
          },
          handleAction,
        });
        let receiving = false;
        plugin.directory = {
          listPeers: async () => [
            { kind: "user", id: receiving ? "recipient-2" : "recipient-1", name: "g" },
          ],
        };
        setTestPlugin(plugin, "gatewaychat");
        const cfg = createEnabledMessageActionConfig("gatewaychat");
        const { sendHandlers } = await import("../../gateway/server-methods/send.js");
        const { runMessageActionRequest } = createMessageMethodTestDriver(() => sendHandlers);
        mocks.callGatewayLeastPrivilege.mockImplementation(
          async ({ params }: { params: Record<string, unknown> }) => {
            receiving = true;
            try {
              const { respond } = await runMessageActionRequest(
                params,
                { connect: { scopes } },
                makeContext(() => ({ ...cfg })),
              );
              const [ok, payload, error]: readonly unknown[] = respond.mock.calls[0] ?? [];
              if (!ok) {
                throw new Error(
                  String(readRecordField({ error }, "error", "Gateway error").message),
                );
              }
              return payload;
            } finally {
              receiving = false;
            }
          },
        );
        const invoke = (to: string, channel?: string) =>
          runMessageAction({
            cfg,
            action: "edit",
            params: { channel, to, messageId: "message-1", message: "updated" },
            conversationReadOrigin: "direct-operator",
            messageActionAuthorization: scheduled
              ? { scheduled: { policy: { version: 1, mode: "trusted" }, assertCurrent: () => {} } }
              : undefined,
            gateway: { clientName: "cli", mode: "cli" },
          });

        await expect(invoke("gatewaychat")).rejects.toThrow("does not specify a destination");
        expect(handleAction).not.toHaveBeenCalled();
        await expect(invoke("g")).resolves.toMatchObject({ payload: { ok: true } });
        expect(handleAction).toHaveBeenLastCalledWith(
          expect.objectContaining({
            gatewayClientScopes: scopes,
            params: expect.objectContaining({ to: scheduled ? "@recipient-2" : "@recipient-1" }),
          }),
        );
        await expect(invoke("gatewaychat", "gatewaychat")).resolves.toMatchObject({
          payload: { ok: true },
        });
        await expect(invoke("@recipient-1")).resolves.toMatchObject({ payload: { ok: true } });
        const call = readMockCallArg(
          mocks.callGatewayLeastPrivilege,
          "concrete destination",
          scheduled ? 3 : 2,
        );
        expect(readRecordField(call, "params", "concrete RPC")).not.toHaveProperty(
          "channelInferred",
        );
        expect(handleAction).toHaveBeenLastCalledWith(
          expect.objectContaining({ gatewayClientScopes: scopes }),
        );
        expect(handleAction).toHaveBeenCalledTimes(3);
        expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(scheduled ? 4 : 3);
      });
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
