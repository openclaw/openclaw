import path from "node:path";
import { expect, vi } from "vitest";
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
  const sendText = vi.fn(async () => ({ channel: "feishu", messageId: "direct-reply-proof" }));
  const feishuPlugin = createOutboundTestPlugin({
    id: "feishu",
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }) =>
        to?.startsWith("user:")
          ? { ok: true, to }
          : { ok: false, error: new Error("expected a direct user target") },
      sendText,
    },
    messaging: {
      normalizeTarget: (raw) => raw,
      resolveDeliveryTarget: ({ conversationId }) => ({ to: `user:${conversationId}` }),
    },
  });
  feishuPlugin.config.listAccountIds = () => ["default", "work"];
  setTestPluginRegistry(
    createTestRegistry([{ pluginId: "feishu", source: "test", plugin: feishuPlugin }]),
  );

  const storePath = path.join(dir, "sessions.json");
  const sessionId = `direct-reply-${expectedAccountId ?? "default"}-${sessionKey.includes(":dm:") ? "dm" : "direct"}`;
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: { [sessionKey]: { sessionId, updatedAt: Date.now() } },
  });
  const session = { agentId: "main", sessionKey, storePath, sessionId };
  const entry = loadSessionEntry(session);

  await runSessionsSendA2AFlow({
    callGateway: bindAgentToolGatewayRequest(params),
    runId: "direct-reply-proof",
    targetAgentId: "main",
    targetSessionKey: sessionKey,
    displayKey: sessionKey,
    requesterAgentId: "main",
    requesterSessionKey: sessionKey,
    requesterChannel: "feishu",
    requesterDeliveryGeneration: {
      ...session,
      lifecycleRevision: entry?.lifecycleRevision ?? null,
    },
    replyTimeoutMs: 5_000,
    reply: {
      status: "ok",
      replyText: "same-session reply delivered",
      terminalReply: { disposition: "visible", text: "same-session reply delivered" },
    },
  });

  expect(sendText).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      to: "user:ou_reply_recipient",
      text: "same-session reply delivered",
      ...(expectedAccountId ? { accountId: expectedAccountId } : {}),
    }),
  );
}
