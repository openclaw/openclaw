import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveFailoverReasonFromError } from "../agents/failover-error.js";
import { projectInternalRealtimeVoicePublicConfig } from "../talk/provider-internal.js";
import type { CreateTalkRealtimeRelaySessionParams } from "./talk-realtime-relay-state.js";

export function resolveTalkRealtimeRelayPresentation(
  params: Pick<
    CreateTalkRealtimeRelaySessionParams,
    | "provider"
    | "providerConfig"
    | "model"
    | "voice"
    | "clientCapabilities"
    | "voiceSelectionVoices"
  >,
) {
  const providerModel = normalizeOptionalString(params.providerConfig.model);
  const model =
    normalizeOptionalString(params.model) ?? providerModel ?? params.provider.defaultModel;
  const voice =
    normalizeOptionalString(params.voice) ?? normalizeOptionalString(params.providerConfig.voice);
  const voices = [...(params.voiceSelectionVoices ?? [])];
  const publicModel = projectInternalRealtimeVoicePublicConfig({
    provider: params.provider,
    providerConfig: params.providerConfig,
    config: { model },
  }).model;
  const opaqueRoute = Boolean(model && publicModel !== model);
  return {
    publicModel,
    voice,
    selection: {
      provider: params.provider.id,
      model: publicModel,
      voice,
      voices,
      canChange:
        params.clientCapabilities?.includes("voice-selection") === true && voices.length > 0,
    },
    launch: { provider: params.provider.id, model: providerModel ?? model },
    publicError: (error: unknown) =>
      new Error(projectTalkRealtimeRelayProviderError(params.provider.id, opaqueRoute, error)),
  };
}

type TalkRealtimeRelayIssue = {
  code: "realtime_unavailable";
  message: string;
  provider: string;
  model?: string;
  transport: "gateway-relay";
  phase: string;
};

export function createTalkRealtimeRelayIssue(params: {
  message: string;
  provider: string;
  model?: string;
  phase: string;
}): TalkRealtimeRelayIssue {
  return {
    code: "realtime_unavailable",
    message: params.message,
    provider: params.provider,
    ...(params.model ? { model: params.model } : {}),
    transport: "gateway-relay",
    phase: params.phase,
  };
}

export function buildTalkRealtimeRelayIssuePayload(
  relaySessionId: string,
  issue: TalkRealtimeRelayIssue,
) {
  return {
    relaySessionId,
    type: "error" as const,
    message: issue.message,
    code: issue.code,
    provider: issue.provider,
    ...(issue.model ? { model: issue.model } : {}),
    transport: issue.transport,
    phase: issue.phase,
  };
}

function projectTalkRealtimeRelayProviderError(
  provider: string,
  opaqueRoute: boolean,
  error: unknown,
): string {
  if (opaqueRoute) {
    return "Realtime provider error.";
  }
  switch (resolveFailoverReasonFromError(error, provider)) {
    case "auth":
    case "auth_permanent":
      return "Realtime provider authentication failed. Check the provider credentials and try again.";
    case "format":
    case "model_not_found":
      return "Realtime session configuration was rejected. Check the provider and model settings.";
    case "rate_limit":
    case "billing":
      return "Realtime provider cannot start this session right now. Try again later.";
    case "timeout":
    case "overloaded":
    case "server_error":
      return "Realtime provider is unavailable. Try again later.";
    default:
      return "Realtime provider error.";
  }
}
