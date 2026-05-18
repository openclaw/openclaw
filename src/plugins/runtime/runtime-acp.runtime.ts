import crypto from "node:crypto";
import type {
  SpawnAcpContext,
  SpawnAcpParams,
  SpawnAcpResult,
} from "../../agents/acp-spawn-contract.js";
import { spawnAcpDirect } from "../../agents/acp-spawn.js";
import { getRuntimeConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { resolveConversationDeliveryTarget } from "../../utils/delivery-context.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";

export type RuntimeAcpPromptParams = {
  sessionKey: string;
  text: string;
  channel?: string;
  accountId?: string;
  /**
   * Alias for channels where the threaded destination is also the conversation
   * id itself (for example Discord thread channels).
   */
  threadId?: string;
  /** Channel-native conversation id to deliver back into. */
  conversationId?: string;
  /** Optional parent conversation id when the channel models child threads/topics separately. */
  parentConversationId?: string;
};

function resolveAcpRuntimePluginId(): string {
  const pluginId = getPluginRuntimeGatewayRequestScope()?.pluginId?.trim();
  if (!pluginId) {
    throw new Error(
      "api.runtime.acp helpers require a loaded plugin runtime scope with plugin identity",
    );
  }
  return pluginId;
}

function assertAcpRuntimeEnabled(): void {
  const pluginId = resolveAcpRuntimePluginId();
  const cfg = getRuntimeConfig();
  if (cfg?.plugins?.entries?.[pluginId]?.acp?.allowSpawn !== true) {
    throw new Error(
      `api.runtime.acp helpers require plugins.entries.${pluginId}.acp.allowSpawn: true in openclaw.json`,
    );
  }
}

export async function spawnPluginAcp(
  params: SpawnAcpParams,
  ctx: SpawnAcpContext,
): Promise<SpawnAcpResult> {
  assertAcpRuntimeEnabled();
  return await spawnAcpDirect(params, ctx);
}

export async function promptPluginAcp(params: RuntimeAcpPromptParams): Promise<{ runId: string }> {
  assertAcpRuntimeEnabled();

  const conversationId = params.conversationId?.trim() || params.threadId?.trim();
  const hasDeliveryTarget = Boolean(params.channel && conversationId);
  const resolvedDelivery = hasDeliveryTarget
    ? resolveConversationDeliveryTarget({
        channel: params.channel,
        conversationId,
        parentConversationId: params.parentConversationId,
      })
    : {};
  const idempotencyKey = crypto.randomUUID();
  const response = await callGateway<{ runId?: string }>({
    method: "agent",
    params: {
      message: params.text,
      sessionKey: params.sessionKey,
      ...(hasDeliveryTarget
        ? {
            channel: params.channel,
            ...(resolvedDelivery.to ? { to: resolvedDelivery.to } : {}),
            ...(params.accountId ? { accountId: params.accountId } : {}),
            ...(resolvedDelivery.threadId ? { threadId: resolvedDelivery.threadId } : {}),
            deliver: true,
          }
        : {}),
      acpTurnSource: "manual_spawn",
      idempotencyKey,
    },
    timeoutMs: 10_000,
  });
  const runId = typeof response?.runId === "string" ? response.runId.trim() : "";
  if (!runId) {
    throw new Error(
      `api.runtime.acp.prompt() expected gateway to return runId for idempotencyKey ${idempotencyKey}`,
    );
  }
  return { runId };
}
