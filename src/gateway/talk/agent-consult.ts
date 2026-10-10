import { randomUUID } from "node:crypto";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  getCommandSenderAuthority,
  withCommandSenderAuthority,
} from "../../auto-reply/command-sender-authority.js";
import { normalizeTalkSection } from "../../config/talk.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultChatMessage,
} from "../../talk/agent-consult-tool.js";
import type { ClientVoiceSessionSource } from "../../talk/client-voice-session-source.js";
import { abortChatRunById } from "../chat-abort.js";
import { handleTrustedInternalChatSend } from "../server-methods/chat-send-handler.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/shared-types.js";
import { formatForLog } from "../ws-log.js";
import { prepareTalkAgentConsultTranscript } from "./agent-consult-transcript.js";
import { resolveTalkAgentConsultAuthority } from "./client-gateway-control.js";
import { registerTalkRealtimeRelayAgentRun } from "./relay/operations.js";
import type { RelayAgentRunRegistration } from "./relay/state.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

function terminalTalkChatSendAckError(result: unknown): ErrorShape | undefined {
  const status = asNullableRecord(result)?.status;
  const message =
    status === "timeout"
      ? "Realtime agent consult ended before the run started."
      : status === "error"
        ? "Realtime agent consult failed before the run started."
        : status === "ok"
          ? "Realtime agent consult completed before the tool result subscription started."
          : undefined;
  return message ? errorShape(ErrorCodes.UNAVAILABLE, message) : undefined;
}

export async function startTalkRealtimeAgentConsult(
  request: GatewayRequestHandlerOptions,
  params: {
    sessionTarget: PreparedTalkSessionTarget;
    callId: string;
    args: unknown;
    relaySessionId?: string;
    connId?: string;
    onRunStarted: (
      runId: string,
      context: {
        assertWorkAdmissionCurrent: () => void;
        physicalSource?: ClientVoiceSessionSource;
        onRegistered?: (release: () => void) => void;
      },
    ) => Promise<() => void>;
  },
): Promise<{ ok: true; runId: string; idempotencyKey: string } | { ok: false; error: ErrorShape }> {
  let message: string;
  try {
    message = buildRealtimeVoiceAgentConsultChatMessage(params.args);
  } catch (err) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)) };
  }
  const idempotencyKey = `talk-${params.callId}-${randomUUID()}`;
  const normalizedTalk = normalizeTalkSection(request.context.getRuntimeConfig().talk);
  const authority = resolveTalkAgentConsultAuthority(
    request.client?.connect?.scopes,
    request.client,
  );
  const unavailable = (errorMessage: string) => ({
    ok: false as const,
    error: errorShape(ErrorCodes.UNAVAILABLE, errorMessage),
  });
  return await new Promise<
    { ok: true; runId: string; idempotencyKey: string } | { ok: false; error: ErrorShape }
  >((resolve) => {
    let acknowledged = false;
    const chatSendOptions = {
      ...request,
      client:
        request.client && authority.replyCaller
          ? withCommandSenderAuthority(
              {
                ...request.client,
                connect: {
                  ...request.client.connect,
                  caps: authority.replyCaller.GatewayClientCaps,
                },
              },
              getCommandSenderAuthority(authority.replyCaller),
            )
          : request.client,
      req: {
        type: "req",
        id: `${request.req.id}:talk-tool-call`,
        method: "chat.send",
      },
      params: {
        sessionKey: params.sessionTarget.canonicalKey,
        agentId: params.sessionTarget.agentId,
        message,
        idempotencyKey,
        suppressCommandInterpretation: true,
        systemInputProvenance: {
          kind: "internal_system",
          sourceTool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        },
        ...(normalizedTalk?.consultThinkingLevel
          ? { thinking: normalizedTalk.consultThinkingLevel }
          : {}),
        ...(typeof normalizedTalk?.consultFastMode === "boolean"
          ? { fastMode: normalizedTalk.consultFastMode }
          : {}),
      },
      respond: (ok: boolean, result?: unknown, error?: ErrorShape) => {
        acknowledged = true;
        const ackError = ok
          ? terminalTalkChatSendAckError(result)
          : (error ?? errorShape(ErrorCodes.UNAVAILABLE, "chat.send failed without error"));
        if (ackError) {
          resolve({ ok: false, error: ackError });
          return;
        }
        const candidateRunId = asNullableRecord(result)?.runId;
        const runId = typeof candidateRunId === "string" ? candidateRunId : idempotencyKey;
        resolve(
          runId
            ? { ok: true, runId, idempotencyKey }
            : unavailable("chat.send did not acknowledge an active run"),
        );
      },
    } satisfies GatewayRequestHandlerOptions;
    // Speech owns reusable history; keep consult scaffolding only in the lossless archive.
    const chatSendResult = handleTrustedInternalChatSend(chatSendOptions, undefined, {
      toolsAllow: authority.toolsAllow,
      transcript: { display: false, excludeFromContext: true },
      prepareAssistantTranscriptMessage: prepareTalkAgentConsultTranscript,
      beforeDispatch: async ({ runId, assertCurrent, assertWorkAdmissionCurrent }) => {
        let relayRegistration: RelayAgentRunRegistration | undefined;
        let releaseClient: void | (() => void);
        const hasRelay = Boolean(params.relaySessionId && params.connId);
        const chat = request.context.chatAbortControllers.get(runId);
        const release = () => {
          releaseClient?.();
          relayRegistration?.release();
        };
        try {
          assertCurrent();
          if (params.relaySessionId && params.connId) {
            relayRegistration = await registerTalkRealtimeRelayAgentRun({
              relaySessionId: params.relaySessionId,
              connId: params.connId,
              sessionKey: params.sessionTarget.canonicalKey,
              runId,
              callId: params.callId,
              assertCurrent: assertWorkAdmissionCurrent,
              registerVoice: async (assertRelayCurrent, physicalSource, onRegistered) => {
                await params.onRunStarted(runId, {
                  assertWorkAdmissionCurrent: assertRelayCurrent,
                  physicalSource,
                  onRegistered,
                });
              },
            });
          } else {
            releaseClient = await params.onRunStarted(runId, { assertWorkAdmissionCurrent });
          }
          assertCurrent();
          if (relayRegistration && !relayRegistration.isCurrent()) {
            throw new Error("Realtime relay run registration changed while waiting");
          }
          return release;
        } catch (error) {
          relayRegistration?.abortIfCurrent();
          if (!hasRelay && chat && request.context.chatAbortControllers.get(runId) === chat) {
            abortChatRunById(request.context, {
              runId,
              sessionKey: params.sessionTarget.canonicalKey,
              stopReason: "voice session binding failed",
            });
          }
          release();
          throw error;
        }
      },
    });
    void Promise.resolve(chatSendResult).then(
      () => {
        if (!acknowledged) {
          resolve(unavailable("chat.send did not return a realtime tool result"));
        }
      },
      (error: unknown) => {
        if (acknowledged) {
          request.context.logGateway.warn(
            `realtime Talk agent consult failed after acknowledgement: ${formatForLog(error)}`,
          );
          return;
        }
        resolve(unavailable(formatForLog(error)));
      },
    );
  });
}
