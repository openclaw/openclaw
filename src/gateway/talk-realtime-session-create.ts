import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { TalkSessionCreateParams } from "../../packages/gateway-protocol/src/index.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../talk/agent-run-control-shared.js";
import { resolveTalkSessionAgentId } from "../talk/agent-target.js";
import { ensureClientVoiceAgentSessionEntry } from "../talk/client-voice-session.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../talk/provider-resolver.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  resolveTalkRealtimeGatewayRelayLaunch,
  resolveTalkRealtimeProviderInstructions,
} from "./server-methods/talk-shared.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { TalkRealtimeRelayEventSink } from "./talk-realtime-relay-state.js";
import { createTalkRealtimeRelaySession } from "./talk-realtime-relay.js";
import { rememberUnifiedTalkSession } from "./talk-session-registry.js";

type RealtimeTalkSessionRequest = Pick<
  TalkSessionCreateParams,
  "language" | "model" | "provider" | "sessionKey" | "voice"
>;

export class TalkRealtimeSessionRequestError extends Error {}

export async function createGatewayRealtimeTalkSession(params: {
  context: GatewayRequestContext;
  ownerId: string;
  request: RealtimeTalkSessionRequest;
  eventSink?: TalkRealtimeRelayEventSink;
}) {
  const runtimeConfig = params.context.getRuntimeConfig();
  const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, params.request.provider);
  const launchOptions = buildRealtimeVoiceLaunchOptions({
    requested: params.request,
    defaults: realtimeConfig,
  });
  const agentId = resolveTalkSessionAgentId(runtimeConfig, params.request.sessionKey);
  const resolution = resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId: realtimeConfig.provider,
    providerConfigs: realtimeConfig.providers,
    providerConfigOverrides: launchOptions.model ? { model: launchOptions.model } : {},
    cfg: runtimeConfig,
    agentId,
    defaultModel: realtimeConfig.model,
    surface: "gateway-relay",
  });
  const relayLaunch = resolveTalkRealtimeGatewayRelayLaunch({
    ...resolution,
    cfg: runtimeConfig,
    launchOptions,
    consultRouting: realtimeConfig.consultRouting,
  });
  if (relayLaunch.error) {
    throw new TalkRealtimeSessionRequestError(relayLaunch.error);
  }
  const realtimeContext = await resolveTalkRealtimeProviderInstructions({
    config: runtimeConfig,
    agentId,
    configuredInstructions: realtimeConfig.instructions,
    sessionKey: params.request.sessionKey,
    requireSessionKeyForProfile: true,
    warn: (message) => params.context.logGateway.warn(`talk realtime context: ${message}`),
  });
  const sessionKey =
    realtimeContext.requestedSessionKey ??
    buildAgentMainSessionKey({ agentId: realtimeContext.agentId });
  await ensureClientVoiceAgentSessionEntry({
    agentId: realtimeContext.agentId,
    sessionKey,
  });
  const session = createTalkRealtimeRelaySession({
    context: params.context,
    connId: params.ownerId,
    cfg: runtimeConfig,
    provider: resolution.provider,
    providerConfig: relayLaunch.providerConfig,
    instructions: buildRealtimeInstructions(realtimeContext.instructions),
    tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL],
    model: launchOptions.model,
    sessionKey,
    voice: launchOptions.voice,
    language: normalizeOptionalLowercaseString(params.request.language),
    forceAgentConsultOnFinalTranscript: relayLaunch.forceAgentConsultOnFinalTranscript,
    ...(params.eventSink ? { eventSink: params.eventSink } : {}),
  });
  rememberUnifiedTalkSession(session.relaySessionId, {
    kind: "realtime-relay",
    connId: params.ownerId,
    relaySessionId: session.relaySessionId,
  });
  return {
    ...session,
    sessionId: session.relaySessionId,
    voiceSessionId: session.relaySessionId,
    mode: "realtime" as const,
    brain: "agent-consult" as const,
  };
}
