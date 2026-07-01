// Gateway Talk realtime agent-consult bridge.
// Starts chat.send runs that answer realtime Talk tool calls.
import { createHash, randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type ConnectParams,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeTalkSection } from "../config/talk.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildRealtimeVoiceAgentClarificationResult,
  buildRealtimeVoiceAgentConsultChatMessage,
} from "../talk/agent-consult-tool.js";
import { chatHandlers } from "./server-methods/chat.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
} from "./server-methods/shared-types.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";
import { registerTalkRealtimeRelayAgentRun } from "./talk-realtime-relay.js";
import { formatForLog } from "./ws-log.js";

function hashTalkConsultScope(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function resolveTalkRealtimeAgentConsultSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  relaySessionId?: string;
  connId?: string;
  callId: string;
}): string {
  const parentSessionKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if (parentSessionKey.includes(":subagent:talk:")) {
    return parentSessionKey;
  }
  const agentId = resolveSessionStoreAgentId(params.cfg, parentSessionKey);
  const scope = params.relaySessionId ?? params.connId ?? params.callId;
  return `agent:${agentId}:subagent:talk:${hashTalkConsultScope(`${parentSessionKey}\0${scope}`)}`;
}

/**
 * Starts the agent-consult chat run that backs realtime Talk tool calls.
 */
export async function startTalkRealtimeAgentConsult(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  requestId: string;
  sessionKey: string;
  callId: string;
  args: unknown;
  relaySessionId?: string;
  connId?: string;
}): Promise<
  | {
      ok: true;
      runId: string;
      idempotencyKey: string;
      sessionKey: string;
      status?: "needs_clarification";
      result?: string;
    }
  | {
      ok: false;
      error: ErrorShape;
    }
> {
  let message: string;
  try {
    message = buildRealtimeVoiceAgentConsultChatMessage(params.args);
  } catch (err) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)) };
  }
  const idempotencyKey = `talk-${params.callId}-${randomUUID()}`;
  const cfg = params.context.getRuntimeConfig();
  const normalizedTalk = normalizeTalkSection(cfg.talk);
  const sessionKey = resolveTalkRealtimeAgentConsultSessionKey({
    cfg,
    sessionKey: params.sessionKey,
    relaySessionId: params.relaySessionId,
    connId: params.connId,
    callId: params.callId,
  });
  let chatResponse: { ok: true; result: unknown } | { ok: false; error: ErrorShape } | undefined;
  await chatHandlers["chat.send"]({
    req: {
      type: "req",
      id: `${params.requestId}:talk-tool-call`,
      method: "chat.send",
    },
    client: params.client,
    isWebchatConnect: params.isWebchatConnect,
    context: params.context,
    params: {
      sessionKey,
      message,
      idempotencyKey,
      ...(normalizedTalk?.consultThinkingLevel
        ? { thinking: normalizedTalk.consultThinkingLevel }
        : {}),
      ...(typeof normalizedTalk?.consultFastMode === "boolean"
        ? { fastMode: normalizedTalk.consultFastMode }
        : {}),
    },
    respond: (ok: boolean, result?: unknown, error?: ErrorShape) => {
      chatResponse = ok
        ? { ok: true, result }
        : {
            ok: false,
            error: error ?? errorShape(ErrorCodes.UNAVAILABLE, "chat.send failed without error"),
          };
    },
  } as Parameters<GatewayRequestHandlers[string]>[0]);

  if (!chatResponse) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "chat.send did not return a realtime tool result"),
    };
  }
  if (!chatResponse.ok) {
    return { ok: false, error: chatResponse.error };
  }
  const result = chatResponse.result;
  const resultRecord =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  const runId = typeof resultRecord?.runId === "string" ? resultRecord.runId : idempotencyKey;
  if (resultRecord?.status === "needs_clarification") {
    const clarification =
      resultRecord.clarification && typeof resultRecord.clarification === "object"
        ? (resultRecord.clarification as { question?: string; suggestions?: string[] })
        : {};
    return {
      ok: true,
      runId,
      idempotencyKey,
      sessionKey,
      status: "needs_clarification",
      result: buildRealtimeVoiceAgentClarificationResult(clarification),
    };
  }
  if (params.relaySessionId && params.connId) {
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: params.relaySessionId,
      connId: params.connId,
      sessionKey,
      runId,
      callId: params.callId,
    });
  }
  return { ok: true, runId, idempotencyKey, sessionKey };
}
