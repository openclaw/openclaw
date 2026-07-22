import { randomUUID } from "node:crypto";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../talk/agent-run-control-shared.js";
import { ensureClientVoiceAgentSessionEntry } from "../talk/client-voice-session.js";
import type { RealtimeVoiceOutputMediaEvent } from "../talk/output-media.js";
import type {
  OpenPluginTalkSessionParams,
  PluginTalkSession,
  PluginTalkSessionEvent,
} from "../talk/plugin-session.js";
import { PLUGIN_TALK_AUDIO_FORMAT } from "../talk/plugin-session.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../talk/provider-resolver.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  resolveTalkRealtimeProviderInstructions,
  withRealtimeBrowserOverrides,
} from "./server-methods/talk-shared.js";
import {
  cancelTalkRealtimeRelayTurn,
  createTalkRealtimeRelaySession,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "./talk-realtime-relay.js";

function mapOutputEvent(event: RealtimeVoiceOutputMediaEvent): PluginTalkSessionEvent | undefined {
  if (event.type === "session.start") {
    return undefined;
  }
  if (event.type === "session.end") {
    return { ...event, type: "closed" };
  }
  return event;
}

function requirePluginTalkScope() {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!scope?.context || !scope.pluginId || scope.gatewayMethodDispatchAllowed !== true) {
    throw new Error(
      "runtime.talk.openSession() is available from Gateway-authenticated plugin routes that declare contracts.gatewayMethodDispatch.",
    );
  }
  return { context: scope.context, pluginId: scope.pluginId };
}

export async function openPluginTalkSession(
  params: OpenPluginTalkSessionParams,
): Promise<PluginTalkSession> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error(
      "runtime.talk.openSession() needs a sessionKey so the voice conversation uses the intended OpenClaw agent and workspace.",
    );
  }
  const { context, pluginId } = requirePluginTalkScope();
  const runtimeConfig = context.getRuntimeConfig();
  const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, params.provider);
  const resolution = resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId: realtimeConfig.provider,
    providerConfigs: realtimeConfig.providers,
    cfg: runtimeConfig,
    cfgForResolve: runtimeConfig,
    defaultModel: realtimeConfig.model,
    noRegisteredProviderMessage: "No realtime voice provider registered",
  });
  const launchOptions = buildRealtimeVoiceLaunchOptions({
    requested: params,
    defaults: realtimeConfig,
  });
  const realtimeContext = await resolveTalkRealtimeProviderInstructions({
    config: runtimeConfig,
    configuredInstructions: realtimeConfig.instructions,
    sessionKey,
    requireSessionKeyForProfile: true,
    warn: (message) => context.logGateway.warn(`talk plugin session: ${message}`),
  });
  await ensureClientVoiceAgentSessionEntry({
    agentId: realtimeContext.agentId,
    sessionKey,
  });

  const ownerId = `plugin:${pluginId}:${randomUUID()}`;
  let closed = false;
  const session = createTalkRealtimeRelaySession({
    context,
    connId: ownerId,
    cfg: runtimeConfig,
    provider: resolution.provider,
    providerConfig: withRealtimeBrowserOverrides(resolution.providerConfig, launchOptions),
    instructions: buildRealtimeInstructions(realtimeContext.instructions),
    tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL],
    model: launchOptions.model,
    sessionKey,
    voice: launchOptions.voice,
    language: normalizeOptionalLowercaseString(params.language),
    manageAgentConsult: true,
    forceAgentConsultOnFinalTranscript: realtimeConfig.consultRouting === "force-agent-consult",
    onOutputMediaEvent: async (event) => {
      const mapped = mapOutputEvent(event);
      if (!mapped) {
        return;
      }
      if (mapped.type === "closed") {
        closed = true;
      }
      await params.onEvent(mapped);
    },
  });

  return {
    audio: PLUGIN_TALK_AUDIO_FORMAT,
    sendAudio(pcm, options) {
      if (closed) {
        throw new Error("Talk session is closed");
      }
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: ownerId,
        audioBase64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
        timestamp: options?.timestamp,
      });
    },
    cancelOutput(reason) {
      if (closed) {
        return;
      }
      cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId: ownerId,
        reason: reason?.trim() || "plugin-cancelled",
      });
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      stopTalkRealtimeRelaySession({
        relaySessionId: session.relaySessionId,
        connId: ownerId,
      });
    },
  };
}
