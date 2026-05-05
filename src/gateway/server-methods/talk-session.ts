import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../realtime-voice/agent-consult-tool.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../realtime-voice/provider-resolver.js";
import type { TalkBrain, TalkMode, TalkTransport } from "../../realtime-voice/talk-events.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkSessionCloseParams,
  validateTalkSessionControlParams,
  validateTalkSessionCreateParams,
  validateTalkSessionInputAudioParams,
  validateTalkSessionToolResultParams,
} from "../protocol/index.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import {
  cancelTalkHandoffTurn,
  createTalkHandoff,
  endTalkHandoffTurn,
  revokeTalkHandoff,
  startTalkHandoffTurn,
} from "../talk-handoff.js";
import {
  cancelTalkRealtimeRelayTurn,
  createTalkRealtimeRelaySession,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "../talk-realtime-relay.js";
import {
  forgetUnifiedTalkSession,
  getUnifiedTalkSession,
  rememberUnifiedTalkSession,
  requireUnifiedTalkSessionConn,
} from "../talk-session-registry.js";
import {
  cancelTalkTranscriptionRelayTurn,
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "../talk-transcription-relay.js";
import { formatForLog } from "../ws-log.js";
import {
  broadcastTalkRoomEvents,
  buildRealtimeInstructions,
  buildTalkRealtimeConfig,
  buildTalkTranscriptionConfig,
  canUseTalkDirectTools,
  resolveConfiguredRealtimeTranscriptionProvider,
  talkHandoffErrorCode,
  withRealtimeBrowserOverrides,
} from "./talk-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

function normalizeTalkSessionMode(params: { mode?: string; transport?: string }): TalkMode {
  const mode = normalizeOptionalLowercaseString(params.mode) as TalkMode | undefined;
  if (mode) {
    return mode;
  }
  return normalizeOptionalLowercaseString(params.transport) === "managed-room"
    ? "stt-tts"
    : "realtime";
}

function normalizeTalkSessionTransport(params: {
  mode: TalkMode;
  transport?: string;
}): TalkTransport {
  const transport = normalizeOptionalLowercaseString(params.transport) as TalkTransport | undefined;
  if (transport) {
    return transport;
  }
  return params.mode === "stt-tts" ? "managed-room" : "gateway-relay";
}

function normalizeTalkSessionBrain(params: { mode: TalkMode; brain?: string }): TalkBrain {
  const brain = normalizeOptionalLowercaseString(params.brain) as TalkBrain | undefined;
  if (brain) {
    return brain;
  }
  return params.mode === "transcription" ? "none" : "agent-consult";
}

export const talkSessionHandlers: GatewayRequestHandlers = {
  "talk.session.create": async ({ params, respond, context, client }) => {
    if (!validateTalkSessionCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.session.create params: ${formatValidationErrors(validateTalkSessionCreateParams.errors)}`,
        ),
      );
      return;
    }

    const mode = normalizeTalkSessionMode(params);
    const transport = normalizeTalkSessionTransport({ mode, transport: params.transport });
    const brain = normalizeTalkSessionBrain({ mode, brain: params.brain });

    if (transport === "webrtc" || transport === "provider-websocket") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `talk.session.create is Gateway-managed; use talk.realtime.session for browser transport "${transport}"`,
        ),
      );
      return;
    }

    try {
      if (transport === "managed-room") {
        if (brain === "direct-tools" && !canUseTalkDirectTools(client)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `talk.session.create brain="direct-tools" requires gateway scope: ${ADMIN_SCOPE}`,
            ),
          );
          return;
        }
        const resolvedSession = await resolveSessionKeyFromResolveParams({
          cfg: context.getRuntimeConfig(),
          p: {
            key: params.sessionKey,
            includeGlobal: true,
            includeUnknown: true,
          },
        });
        if (!resolvedSession.ok) {
          respond(false, undefined, resolvedSession.error);
          return;
        }
        const handoff = createTalkHandoff({
          sessionKey: resolvedSession.key,
          provider: normalizeOptionalString(params.provider),
          model: normalizeOptionalString(params.model),
          voice: normalizeOptionalString(params.voice),
          mode,
          transport,
          brain,
          ttlMs: params.ttlMs,
        });
        rememberUnifiedTalkSession(handoff.id, {
          kind: "managed-room",
          handoffId: handoff.id,
          token: handoff.token,
          roomId: handoff.roomId,
        });
        respond(
          true,
          {
            sessionId: handoff.id,
            provider: handoff.provider,
            mode: handoff.mode,
            transport: handoff.transport,
            brain: handoff.brain,
            handoffId: handoff.id,
            roomId: handoff.roomId,
            roomUrl: handoff.roomUrl,
            token: handoff.token,
            model: handoff.model,
            voice: handoff.voice,
            expiresAt: handoff.expiresAt,
          },
          undefined,
        );
        return;
      }

      const connId = client?.connId;
      if (!connId) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Talk session unavailable"));
        return;
      }

      if (mode === "realtime") {
        if (transport !== "gateway-relay" || brain !== "agent-consult") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `realtime talk.session.create requires transport="gateway-relay" and brain="agent-consult"`,
            ),
          );
          return;
        }
        const runtimeConfig = context.getRuntimeConfig();
        const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, params.provider);
        const resolution = resolveConfiguredRealtimeVoiceProvider({
          configuredProviderId: realtimeConfig.provider,
          providerConfigs: realtimeConfig.providers,
          cfg: runtimeConfig,
          cfgForResolve: runtimeConfig,
          noRegisteredProviderMessage: "No realtime voice provider registered",
        });
        const model = normalizeOptionalString(params.model) ?? realtimeConfig.model;
        const voice = normalizeOptionalString(params.voice) ?? realtimeConfig.voice;
        const session = createTalkRealtimeRelaySession({
          context,
          connId,
          provider: resolution.provider,
          providerConfig: withRealtimeBrowserOverrides(resolution.providerConfig, { model, voice }),
          instructions: buildRealtimeInstructions(),
          tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL],
          model,
          voice,
        });
        rememberUnifiedTalkSession(session.relaySessionId, {
          kind: "realtime-relay",
          connId,
          relaySessionId: session.relaySessionId,
        });
        respond(
          true,
          {
            ...session,
            sessionId: session.relaySessionId,
            mode,
            brain,
          },
          undefined,
        );
        return;
      }

      if (mode === "transcription") {
        if (transport !== "gateway-relay" || brain !== "none") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `transcription talk.session.create requires transport="gateway-relay" and brain="none"`,
            ),
          );
          return;
        }
        const runtimeConfig = context.getRuntimeConfig();
        const transcriptionConfig = buildTalkTranscriptionConfig(runtimeConfig, params.provider);
        const resolution = resolveConfiguredRealtimeTranscriptionProvider({
          config: runtimeConfig,
          configuredProviderId: transcriptionConfig.provider,
          providerConfigs: transcriptionConfig.providers,
        });
        const session = createTalkTranscriptionRelaySession({
          context,
          connId,
          provider: resolution.provider,
          providerConfig: resolution.providerConfig,
        });
        rememberUnifiedTalkSession(session.transcriptionSessionId, {
          kind: "transcription-relay",
          connId,
          transcriptionSessionId: session.transcriptionSessionId,
        });
        respond(
          true,
          {
            ...session,
            sessionId: session.transcriptionSessionId,
            brain,
          },
          undefined,
        );
        return;
      }

      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `stt-tts talk.session.create requires transport="managed-room"`,
        ),
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.session.inputAudio": async ({ params, respond, client }) => {
    if (!validateTalkSessionInputAudioParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.session.inputAudio params: ${formatValidationErrors(validateTalkSessionInputAudioParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId,
          audioBase64: params.audioBase64,
          timestamp: params.timestamp,
        });
        respond(true, { ok: true }, undefined);
        return;
      }
      if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        sendTalkTranscriptionRelayAudio({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
          audioBase64: params.audioBase64,
        });
        respond(true, { ok: true }, undefined);
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "talk.session.inputAudio is not supported for managed-room sessions",
        ),
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.session.control": async ({ params, respond, client, context }) => {
    if (!validateTalkSessionControlParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.session.control params: ${formatValidationErrors(validateTalkSessionControlParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        if (params.type !== "turn.cancel") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `realtime relay sessions only support talk.session.control type="turn.cancel"`,
            ),
          );
          return;
        }
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        cancelTalkRealtimeRelayTurn({
          relaySessionId: session.relaySessionId,
          connId,
          reason: normalizeOptionalString(params.reason),
        });
        respond(true, { ok: true }, undefined);
        return;
      }
      if (session.kind === "transcription-relay") {
        if (params.type !== "turn.cancel") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `transcription relay sessions only support talk.session.control type="turn.cancel"`,
            ),
          );
          return;
        }
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        cancelTalkTranscriptionRelayTurn({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
          reason: normalizeOptionalString(params.reason),
        });
        respond(true, { ok: true }, undefined);
        return;
      }

      const result =
        params.type === "turn.start"
          ? startTalkHandoffTurn(session.handoffId, session.token, {
              turnId: params.turnId,
              clientId: client?.connId,
            })
          : params.type === "turn.end"
            ? endTalkHandoffTurn(session.handoffId, session.token, { turnId: params.turnId })
            : cancelTalkHandoffTurn(session.handoffId, session.token, {
                turnId: params.turnId,
                reason: params.reason,
              });
      if (!result.ok) {
        respond(
          false,
          undefined,
          errorShape(
            talkHandoffErrorCode(result.reason),
            `talk session control failed: ${result.reason}`,
          ),
        );
        return;
      }
      broadcastTalkRoomEvents(context, result.record.room.activeClientId, {
        handoffId: result.record.id,
        roomId: result.record.roomId,
        events: result.events,
      });
      respond(true, { ok: true, turnId: result.turnId, events: result.events }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.session.toolResult": async ({ params, respond, client }) => {
    if (!validateTalkSessionToolResultParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.session.toolResult params: ${formatValidationErrors(validateTalkSessionToolResultParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "talk.session.toolResult is only supported for realtime relay sessions",
          ),
        );
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId,
        callId: params.callId,
        result: params.result,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.session.close": async ({ params, respond, client }) => {
    if (!validateTalkSessionCloseParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.session.close params: ${formatValidationErrors(validateTalkSessionCloseParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId });
      } else if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        stopTalkTranscriptionRelaySession({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
        });
      } else {
        revokeTalkHandoff(session.handoffId);
      }
      forgetUnifiedTalkSession(params.sessionId);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
