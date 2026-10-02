import path from "node:path";
import { expect } from "vitest";
import { bindAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import { runSessionsSendA2AFlow } from "../agents/tools/sessions-send-tool.a2a.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { setTestPluginRegistry, testState, writeSessionStore } from "./test-helpers.js";

export async function runDirectSessionReplyScenario(params: {
  dir: string;
  sessionKey: string;
  expectedAccountId: string | undefined;
  resolveGatewayContext: GatewayContextResolver;
}): Promise<void> {
  const { dir, sessionKey, expectedAccountId } = params;
  const sendCalls: Array<{
    to?: string;
    text?: string;
    accountId?: string | null;
  }> = [];
  const feishuPlugin = createOutboundTestPlugin({
    id: "feishu",
    label: "Feishu",
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }) =>
        to?.startsWith("user:")
          ? { ok: true, to }
          : { ok: false, error: new Error("expected a direct user target") },
      sendText: async (ctx) => {
        sendCalls.push({ to: ctx.to, text: ctx.text, accountId: ctx.accountId });
        return { channel: "feishu", messageId: "direct-reply-proof" };
      },
    },
    messaging: {
      normalizeTarget: (raw) => raw,
      resolveDeliveryTarget: ({ conversationId }) => ({ to: `user:${conversationId}` }),
    },
  });
  setTestPluginRegistry(
    createTestRegistry([
      {
        pluginId: "feishu",
        source: "test",
        plugin: {
          ...feishuPlugin,
          config: {
            ...feishuPlugin.config,
            listAccountIds: () => ["default", "work"],
          },
        },
      },
    ]),
  );

  const storePath = path.join(dir, "sessions.json");
  const sessionId = `direct-reply-${expectedAccountId ?? "default"}-${sessionKey.includes(":dm:") ? "dm" : "direct"}`;
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: {
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    },
  });
  const entry = loadSessionEntry({ sessionKey, storePath });
  expect(entry?.sessionId).toBe(sessionId);

  await runSessionsSendA2AFlow({
    callGateway: bindAgentToolGatewayRequest({
      resolveGatewayContext: params.resolveGatewayContext,
    }),
    runId: "direct-reply-proof",
    targetAgentId: "main",
    targetSessionKey: sessionKey,
    displayKey: sessionKey,
    requesterAgentId: "main",
    requesterSessionKey: sessionKey,
    requesterChannel: "feishu",
    requesterDeliveryGeneration: {
      agentId: "main",
      storePath,
      sessionKey,
      sessionId,
      lifecycleRevision: entry?.lifecycleRevision ?? null,
    },
    replyTimeoutMs: 5_000,
    reply: { status: "ok", replyText: "same-session reply delivered" },
  });

  expect(sendCalls).toHaveLength(1);
  expect(sendCalls[0]).toMatchObject({
    to: "user:ou_reply_recipient",
    text: "same-session reply delivered",
    ...(expectedAccountId ? { accountId: expectedAccountId } : {}),
  });
}
