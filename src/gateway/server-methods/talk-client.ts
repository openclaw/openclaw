// Talk client methods create browser-owned realtime voice sessions and route
// client tool calls back into OpenClaw agent consult/control flows.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkClientCreateParams,
  validateTalkClientCloseParams,
  validateTalkClientSteerParams,
  validateTalkClientToolCallParams,
  validateTalkClientTranscriptParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveRealtimeContextPackInstructions } from "../../agents/realtime-context-pack.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultPolicyInstructions,
  parseRealtimeVoiceAgentConsultArgs,
} from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../talk/agent-run-control-shared.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import {
  activateClientVoiceConfirmationSession,
  authorizeClientVoiceConfirmation,
} from "../../talk/client-voice-confirmation.js";
import {
  appendClientVoiceTranscript,
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  readClientVoiceConsultTranscript,
  registerClientVoiceConsultRun,
} from "../../talk/client-voice-session.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../talk/provider-resolver.js";
import { startTalkRealtimeAgentConsult } from "../talk-agent-consult.js";
import { formatForLog } from "../ws-log.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  isUnsupportedBrowserWebRtcSession,
} from "./talk-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Gateway methods for browser-owned realtime Talk sessions.
 *
 * These handlers create provider browser sessions and bridge client-owned tool
 * calls back into OpenClaw agent consult runs.
 */
export const talkClientHandlers: GatewayRequestHandlers = {
  "talk.client.create": async ({ params, respond, context }) => {
    if (!validateTalkClientCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.create params: ${formatValidationErrors(validateTalkClientCreateParams.errors)}`,
        ),
      );
      return;
    }
    const typedParams = params as {
      sessionKey?: string;
      voiceSessionId?: string;
      provider?: string;
      model?: string;
      voice?: string;
      vadThreshold?: number;
      silenceDurationMs?: number;
      prefixPaddingMs?: number;
      reasoningEffort?: string;
      mode?: string;
      transport?: string;
      brain?: string;
    };
    try {
      const runtimeConfig = context.getRuntimeConfig();
      const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, typedParams.provider);
      const mode =
        normalizeOptionalLowercaseString(typedParams.mode) ?? realtimeConfig.mode ?? "realtime";
      if (mode !== "realtime") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`,
          ),
        );
        return;
      }
      const brain =
        normalizeOptionalLowercaseString(typedParams.brain) ??
        realtimeConfig.brain ??
        "agent-consult";
      if (brain !== "agent-consult") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create only supports brain="agent-consult"`,
          ),
        );
        return;
      }
      const transport =
        normalizeOptionalLowercaseString(typedParams.transport) ?? realtimeConfig.transport;
      if (transport === "managed-room") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "managed-room realtime Talk sessions are not available in the browser UI yet",
          ),
        );
        return;
      }
      if (transport === "gateway-relay") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create is client-owned; use talk.session.create for gateway-relay`,
          ),
        );
        return;
      }
      const resolution = resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        cfg: runtimeConfig,
        cfgForResolve: runtimeConfig,
        defaultModel: realtimeConfig.model,
        noRegisteredProviderMessage: "No realtime voice provider registered",
      });
      const launchOptions = buildRealtimeVoiceLaunchOptions({
        requested: typedParams,
        defaults: realtimeConfig,
      });
      const agentId = resolveAgentIdFromSessionKey(typedParams.sessionKey);
      const sessionKey = typedParams.sessionKey?.trim() || "main";
      const contextPack = await resolveRealtimeContextPackInstructions({
        agentId,
        config: runtimeConfig,
        sessionKey: typedParams.sessionKey,
        warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
      });
      const toolPolicy = realtimeConfig.toolPolicy ?? "owner";
      const consultPolicyInstructions = buildRealtimeVoiceAgentConsultPolicyInstructions({
        toolPolicy,
        consultPolicy: realtimeConfig.consultPolicy,
      });
      const configuredInstructions = [
        realtimeConfig.instructions,
        consultPolicyInstructions,
        contextPack,
      ]
        .filter((entry): entry is string => Boolean(entry?.trim()))
        .join("\n\n");
      if (resolution.provider.createBrowserSession && transport !== "gateway-relay") {
        const session = await resolution.provider.createBrowserSession({
          cfg: runtimeConfig,
          providerConfig: resolution.providerConfig,
          instructions: buildRealtimeInstructions(configuredInstructions),
          tools:
            toolPolicy === "none"
              ? []
              : [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL],
          ...launchOptions,
        });
        if (
          !isUnsupportedBrowserWebRtcSession(session) &&
          (!transport || session.transport === transport)
        ) {
          if (realtimeConfig.voiceSession?.enabled === true) {
            await closeStaleClientVoiceSessions({
              agentId,
              config: runtimeConfig,
              persistTranscript: realtimeConfig.voiceSession.persistTranscript === true,
              postCallSummary: realtimeConfig.voiceSession.postCallSummary === "mutations",
              excludeVoiceSessionId: normalizeOptionalString(typedParams.voiceSessionId),
              warn: (message) => context.logGateway.warn(`talk voice session recovery: ${message}`),
            });
          }
          const voiceSessionId =
            realtimeConfig.voiceSession?.enabled === true
              ? createOrResumeClientVoiceSession({
                  agentId,
                  sessionKey,
                  voiceSessionId: normalizeOptionalString(typedParams.voiceSessionId),
                })
              : undefined;
          respond(true, { ...session, ...(voiceSessionId ? { voiceSessionId } : {}) }, undefined);
          return;
        }
        if (transport) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `Realtime provider "${resolution.provider.id}" does not support requested browser transport "${transport}"`,
            ),
          );
          return;
        }
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Realtime provider "${resolution.provider.id}" does not support client-owned realtime sessions`,
        ),
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.client.toolCall": async (request) => {
    const { params, respond } = request;
    if (!validateTalkClientToolCallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.toolCall params: ${formatValidationErrors(validateTalkClientToolCallParams.errors)}`,
        ),
      );
      return;
    }
    if (params.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported realtime Talk tool: ${params.name}`),
      );
      return;
    }

    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    const voiceSessionId = normalizeOptionalString(params.voiceSessionId);
    let transcript;
    try {
      const parsedArgs = parseRealtimeVoiceAgentConsultArgs(params.args ?? {});
      transcript = voiceSessionId
        ? readClientVoiceConsultTranscript({
            agentId,
            sessionKey: params.sessionKey,
            voiceSessionId,
          })
        : undefined;
      if (voiceSessionId) {
        const realtimeConfig = buildTalkRealtimeConfig(request.context.getRuntimeConfig());
        if (realtimeConfig.voiceSession?.confirmationPolicy === "high-impact-outbound") {
          activateClientVoiceConfirmationSession({
            sessionKey: params.sessionKey,
            voiceSessionId,
          });
        }
        if (parsedArgs.confirmationId) {
          authorizeClientVoiceConfirmation({
            sessionKey: params.sessionKey,
            voiceSessionId,
            confirmationId: parsedArgs.confirmationId,
          });
        }
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return;
    }
    const result = await startTalkRealtimeAgentConsult({
      context: request.context,
      client: request.client,
      isWebchatConnect: request.isWebchatConnect,
      requestId: request.req.id,
      sessionKey: params.sessionKey,
      callId: params.callId,
      args: params.args ?? {},
      transcript,
      relaySessionId: normalizeOptionalString(params.relaySessionId),
      connId: normalizeOptionalString(request.client?.connId),
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    if (voiceSessionId) {
      registerClientVoiceConsultRun({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId,
        runId: result.runId,
      });
    }
    respond(
      true,
      {
        runId: result.runId,
        idempotencyKey: result.idempotencyKey,
      },
      undefined,
    );
  },
  "talk.client.transcript": async ({ params, respond }) => {
    if (!validateTalkClientTranscriptParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.transcript params: ${formatValidationErrors(validateTalkClientTranscriptParams.errors)}`,
        ),
      );
      return;
    }
    try {
      appendClientVoiceTranscript({
        agentId: resolveAgentIdFromSessionKey(params.sessionKey),
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
        entryId: params.entryId,
        role: params.role,
        text: params.text,
        timestamp: params.timestamp,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.close": async ({ params, respond, context }) => {
    if (!validateTalkClientCloseParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.close params: ${formatValidationErrors(validateTalkClientCloseParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const realtimeConfig = buildTalkRealtimeConfig(context.getRuntimeConfig());
      const result = await closeClientVoiceSession({
        agentId: resolveAgentIdFromSessionKey(params.sessionKey),
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
        config: context.getRuntimeConfig(),
        persistTranscript: realtimeConfig.voiceSession?.persistTranscript === true,
        postCallSummary: realtimeConfig.voiceSession?.postCallSummary === "mutations",
      });
      respond(true, { ok: true, imported: result.imported }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.steer": async ({ params, respond, client, context }) => {
    if (!validateTalkClientSteerParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.steer params: ${formatValidationErrors(validateTalkClientSteerParams.errors)}`,
        ),
      );
      return;
    }
    if (
      !hasOwnedActiveTalkClientRun({
        context,
        clientConnId: client?.connId,
        sessionKey: params.sessionKey,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "talk.client.steer requires an active browser-owned Talk run",
        ),
      );
      return;
    }
    try {
      const result = await controlRealtimeVoiceAgentRun({
        sessionKey: params.sessionKey,
        text: params.text,
        mode: params.mode,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};

function hasOwnedActiveTalkClientRun(params: {
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"];
  clientConnId?: string;
  sessionKey: string;
}): boolean {
  // Browser steering is only allowed for the connection that owns the live
  // browser session; agent-owned consult runs use the relay steering path.
  const connId = normalizeOptionalString(params.clientConnId);
  const sessionKey = params.sessionKey.trim();
  if (!connId || !sessionKey) {
    return false;
  }
  for (const entry of params.context.chatAbortControllers.values()) {
    if (entry.sessionKey === sessionKey && entry.ownerConnId === connId && entry.kind !== "agent") {
      return true;
    }
  }
  return false;
}
