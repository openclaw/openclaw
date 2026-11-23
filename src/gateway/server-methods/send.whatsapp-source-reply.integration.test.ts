import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../../agents/tools/message-tool-execution.js";
import {
  messageGatewayContext,
  registerMessageChannel,
  stubMessageSecrets,
} from "../../agents/tools/message-tool-execution.test-support.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../message-action-turn-capability.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { sendHandlers } from "./send.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

it("keeps a tool-delivered WhatsApp DM answer in its source transcript exactly once", async () => {
  await withOpenClawTestState({ prefix: "whatsapp-source-reply-" }, async (state) => {
    const to = "+12025550123";
    const sessionKey = "agent:main:whatsapp:direct:" + to;
    const sessionId = "whatsapp-source-session";
    const runId = "whatsapp-source-run";
    const scope = {
      agentId: "main",
      sessionKey,
      sessionId,
      storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir } },
      session: { store: scope.storePath, dmScope: "per-channel-peer" },
      channels: { whatsapp: { enabled: true } },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg, cfg);
    await replaceSessionEntry(scope, { sessionId, updatedAt: 1, chatType: "direct" });
    stubMessageSecrets();
    const { whatsappPlugin } = await loadBundledPluginFacade<{ whatsappPlugin: ChannelPlugin }>({
      pluginId: "whatsapp",
      artifactBasename: "api.js",
    });
    const send = vi.fn(async (_to: string, _text: string) => ({
      messageId: "wa-42",
      toJid: "12025550123@s.whatsapp.net",
    }));
    const sendText = expectDefined(whatsappPlugin.message?.send?.text, "WhatsApp text sender");
    registerMessageChannel({
      ...whatsappPlugin,
      message: {
        ...whatsappPlugin.message,
        send: {
          ...whatsappPlugin.message?.send,
          text: (ctx) => sendText({ ...ctx, deps: { whatsapp: send } }),
        },
      },
    });
    const methods = createGatewayMethodRegistry(
      (["send", "message.action"] as const).map((name) => ({
        name,
        owner: { kind: "core", area: "message" },
        scope: "operator.write",
        handler: expectDefined(sendHandlers[name], name),
      })),
    );
    const context = messageGatewayContext(
      () => cfg,
      expectDefined(sendHandlers["message.action"], "message.action"),
      {
        getGatewayMethodRegistry: () => methods,
        dedupe: new Map(),
        deps: { whatsapp: send },
      },
    );
    const source = {
      currentChannelProvider: "whatsapp",
      currentChannelId: to,
      currentMessagingTarget: to,
      currentChatType: "direct" as const,
      currentSourceTurnId: "source-turn-42",
    };
    const capability = mintMessageActionTurnCapability({
      agentId: "main",
      sessionKey,
      runId,
      requesterAccountId: "default",
      toolContext: source,
    });
    const operationalRunInstance = createOperationalRunInstanceRef(runId);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    try {
      const tool = createMessageTool({
        config: cfg,
        agentId: "main",
        agentSessionKey: sessionKey,
        runSessionKey: sessionKey,
        sessionId,
        runId,
        agentAccountId: "default",
        ...source,
        messageActionTurnCapability: capability,
        sourceReplyDeliveryMode: "message_tool_only",
      });
      const invoke = () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            operationalRunInstance,
            gatewayContextResolver: () => context,
          },
          () => tool.execute("wa-final", { action: "send", message: "WA-HISTORY-42", final: true }),
        );
      const result = await invoke();
      expect(result.details).toMatchObject({
        messageDelivery: { status: "settled", sourceReplyDelivered: true },
      });
      await invoke();
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.slice(0, 2)).toEqual([to, "WA-HISTORY-42"]);
      const answers = (await loadTranscriptEvents(scope))
        .map(readTranscriptEventMessage)
        .filter((row) => row?.role === "assistant");
      expect(answers).toMatchObject([
        {
          content: [{ type: "text", text: "WA-HISTORY-42" }],
          openclawDeliveryMirror: {
            final: true,
            sourceTurnId: "source-turn-42",
            toolCallId: "wa-final",
          },
        },
      ]);
    } finally {
      revokeMessageActionTurnCapability(capability);
      releaseAgentRunDelegatedAuthority(authority);
    }
  });
});
