import { performance } from "node:perf_hooks";
import type { GatewayClientInfo } from "../../../packages/gateway-protocol/src/client-info.js";
import type { emitDiagnosticsTimelineEvent } from "../../infra/diagnostics-timeline.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
import type { ChatRunTiming } from "../server-chat-state.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type ChatSendTimingContext = {
  client?: GatewayClient | null;
  request: { chatSendReceivedAtMs: number; clientInfo?: GatewayClientInfo };
  session: { clientRunId: string; sessionKey: string; agentId: string; sessionLoadMs: number };
};

type ChatSendAckServerTiming = {
  receivedToAckMs: number;
  loadSessionMs: number;
  prepareAttachmentsMs?: number;
};

type ChatSendServerTimingPhase =
  | "dispatch-started"
  | "model-selected"
  | "agent-run-started"
  | "first-assistant-event"
  | "dispatch-completed"
  | "post-dispatch-completed";

export function roundedChatSendTimingMs(value: number): number {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function chatSendAckServerTimingAttributes(
  timing: ChatSendAckServerTiming | undefined,
): Record<string, number> {
  if (!timing) {
    return {};
  }
  return {
    serverReceivedToAckMs: timing.receivedToAckMs,
    serverLoadSessionMs: timing.loadSessionMs,
    ...(timing.prepareAttachmentsMs !== undefined
      ? { serverPrepareAttachmentsMs: timing.prepareAttachmentsMs }
      : {}),
  };
}

export function prepareChatSendAckTiming({
  client,
  request: { clientInfo, chatSendReceivedAtMs },
  session: { sessionLoadMs },
  prepareAttachmentsMs,
  chatSendTraceAttributes,
}: ChatSendTimingContext & {
  prepareAttachmentsMs?: number;
  chatSendTraceAttributes: NonNullable<
    Parameters<typeof emitDiagnosticsTimelineEvent>[0]["attributes"]
  >;
}) {
  const serverTiming = isOperatorUiClient(clientInfo)
    ? {
        receivedToAckMs: roundedChatSendTimingMs(performance.now() - chatSendReceivedAtMs),
        loadSessionMs: sessionLoadMs,
        ...(prepareAttachmentsMs !== undefined ? { prepareAttachmentsMs } : {}),
      }
    : undefined;
  const chatSendTiming: ChatRunTiming | undefined =
    serverTiming && typeof client?.connId === "string" && client.connId.trim()
      ? {
          ackedAtMs: performance.now(),
          connId: client.connId.trim(),
          receivedAtMs: chatSendReceivedAtMs,
        }
      : undefined;
  return {
    serverTiming,
    chatSendTiming,
    ackReadyEvent: (ackStatus: string): Parameters<typeof emitDiagnosticsTimelineEvent>[0] => ({
      type: "mark",
      name: "gateway.chat_send.ack_ready",
      phase: "agent-turn",
      attributes: {
        ...chatSendTraceAttributes,
        ackStatus,
        ...chatSendAckServerTimingAttributes(serverTiming),
      },
    }),
  };
}

const CONTROL_UI_RECONNECT_RESUME_PARAM = "__controlUiReconnectResume";

export function resolveControlUiReconnectResumeParams(
  params: unknown,
  clientInfo?: { id?: string | null; mode?: string | null },
): { params: unknown; resumeRequested: boolean } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { params, resumeRequested: false };
  }
  const record = params as Record<string, unknown>;
  const resumeRequested =
    record[CONTROL_UI_RECONNECT_RESUME_PARAM] === true && isOperatorUiClient(clientInfo);
  if (!resumeRequested) {
    return { params, resumeRequested: false };
  }
  const validatedParams = { ...record };
  delete validatedParams[CONTROL_UI_RECONNECT_RESUME_PARAM];
  return { params: validatedParams, resumeRequested: true };
}

export function createOperatorChatSendServerTiming({
  context,
  client,
  request: { chatSendReceivedAtMs: receivedAtMs },
  session: { clientRunId: runId, sessionKey, agentId },
  timing: { chatSendAckedAtMs: ackedAtMs, chatSendTiming },
}: ChatSendTimingContext & {
  context: Pick<GatewayRequestContext, "broadcastToConnIds">;
  timing: { chatSendAckedAtMs: number; chatSendTiming?: ChatRunTiming };
}) {
  const startedAtMs = performance.now();
  if (chatSendTiming) {
    chatSendTiming.dispatchStartedAtMs = startedAtMs;
  }
  const connId = client?.connId?.trim();
  const recipients =
    connId && isOperatorUiClient(client?.connect?.client) ? new Set([connId]) : undefined;
  const assistantTiming = chatSendTiming ?? { firstAssistantEventSent: false };
  const emit = (
    phase: ChatSendServerTimingPhase,
    extra?: Record<string, string | number>,
    dispatchStartedAtMs?: number,
  ) => {
    if (!recipients) {
      return;
    }
    const nowMs = performance.now();
    context.broadcastToConnIds(
      "chat.send_timing",
      {
        phase,
        runId,
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ackToPhaseMs: roundedChatSendTimingMs(nowMs - ackedAtMs),
        receivedToPhaseMs: roundedChatSendTimingMs(nowMs - receivedAtMs),
        ...(dispatchStartedAtMs !== undefined
          ? { dispatchStartedToPhaseMs: roundedChatSendTimingMs(nowMs - dispatchStartedAtMs) }
          : {}),
        ...extra,
      },
      recipients,
      { dropIfSlow: true },
    );
  };
  return {
    emit,
    dispatchStartedAtMs: startedAtMs,
    emitFirstAssistant: () => {
      if (assistantTiming.firstAssistantEventSent) {
        return;
      }
      assistantTiming.firstAssistantEventSent = true;
      emit("first-assistant-event", undefined, startedAtMs);
    },
  };
}
