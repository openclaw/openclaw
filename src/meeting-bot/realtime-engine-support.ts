import { normalizeOptionalString as readLogString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
} from "../plugins/types.js";
import {
  getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders,
} from "../realtime-transcription/provider-registry.js";
import type { RealtimeTranscriptionProviderConfig } from "../realtime-transcription/provider-types.js";
import {
  resolveConfiguredRealtimeVoiceProviderAsync,
  type ResolvedRealtimeVoiceProvider,
} from "../talk/provider-resolver.js";
import type { RealtimeVoiceProviderConfig } from "../talk/provider-types.js";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../talk/realtime-session-harness.js";
import { truncateUtf16Safe } from "../utils.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";

const MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS = 900;
// Playback duration plus a tail blocks live loopback; transcript lookback catches delayed echo.
const MEETING_OUTPUT_ECHO_SUPPRESSION_TAIL_MS = 3_000;
const MEETING_TRANSCRIPT_ECHO_LOOKBACK_MS = 45_000;

type HarnessOptions = Parameters<typeof createRealtimeVoiceSessionHarness>[0];

export function createMeetingRealtimeHarness(
  params: {
    config: { chrome: { audioFormat: MeetingRealtimeAudioFormat } };
    transport: { inputAudioIsolated?: boolean };
    logger: NonNullable<HarnessOptions["talkback"]>["logger"];
    meetingSessionId: string;
    requesterSessionKey?: string;
    consultAgent(request: {
      meetingSessionId: string;
      requesterSessionKey?: string;
      args: { question: string; responseStyle: string };
      transcript: RealtimeVoiceSessionHarness["transcript"];
      abortSignal: AbortSignal;
    }): Promise<{ text: string }>;
  },
  options: Pick<HarnessOptions, "talk" | "talkPayloads"> & {
    logPrefix: string;
    deliver: NonNullable<HarnessOptions["talkback"]>["deliver"];
  },
): RealtimeVoiceSessionHarness {
  const harness: RealtimeVoiceSessionHarness = createRealtimeVoiceSessionHarness({
    talk: options.talk,
    talkPayloads: options.talkPayloads,
    echoSuppression: params.transport.inputAudioIsolated
      ? undefined
      : {
          bytesPerMs: meetingOutputBytesPerMs(params.config.chrome.audioFormat),
          tailMs: MEETING_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
          transcriptLookbackMs: MEETING_TRANSCRIPT_ECHO_LOOKBACK_MS,
        },
    talkback: {
      debounceMs: MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS,
      logger: params.logger,
      logPrefix: options.logPrefix,
      responseStyle: "Brief, natural spoken answer for a live meeting.",
      fallbackText: "I hit an error while checking that. Please try again.",
      consult: ({ question, responseStyle, signal }) =>
        params.consultAgent({
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: { question, responseStyle },
          transcript: harness.transcript,
          abortSignal: signal,
        }),
      deliver: options.deliver,
    },
  });
  return harness;
}

type MeetingRealtimeProviderSelectionConfig = {
  realtime: {
    agentId?: string;
    provider?: string;
    transcriptionProvider?: string;
    voiceProvider?: string;
    model?: string;
    providers: Record<string, Record<string, unknown>>;
  };
};

type ResolvedRealtimeTranscriptionProvider = {
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

export function meetingOutputBytesPerMs(audioFormat: MeetingRealtimeAudioFormat): number {
  return audioFormat === "g711-ulaw-8khz" ? 8 : 48;
}

export async function resolveMeetingRealtimeProvider(params: {
  config: MeetingRealtimeProviderSelectionConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeVoiceProviderPlugin[];
}): Promise<ResolvedRealtimeVoiceProvider> {
  const providerId = params.config.realtime.voiceProvider ?? params.config.realtime.provider;
  return resolveConfiguredRealtimeVoiceProviderAsync({
    configuredProviderId: providerId,
    providerConfigs: params.config.realtime.providers,
    cfg: params.fullConfig,
    agentId: params.config.realtime.agentId,
    surface: "gateway-relay",
    useProviderDefaultModel: true,
    providers: params.providers,
    defaultModel: params.config.realtime.model,
    noRegisteredProviderMessage: "No configured realtime voice provider registered",
  });
}

export async function resolveMeetingRealtimeTranscriptionProvider(params: {
  config: MeetingRealtimeProviderSelectionConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeTranscriptionProviderPlugin[];
}): Promise<ResolvedRealtimeTranscriptionProvider> {
  const providers = params.providers ?? listRealtimeTranscriptionProviders(params.fullConfig);
  if (providers.length === 0) {
    throw new Error("No configured realtime transcription provider registered");
  }
  const providerId =
    params.config.realtime.transcriptionProvider ?? params.config.realtime.provider;
  const configuredProvider = providerId
    ? (params.providers?.find(
        (entry) => entry.id === providerId || entry.aliases?.includes(providerId),
      ) ?? getRealtimeTranscriptionProvider(providerId, params.fullConfig))
    : undefined;
  const provider = configuredProvider ?? providers[0];
  if (!provider) {
    throw new Error("No configured realtime transcription provider registered");
  }
  const rawConfig = providerId
    ? (params.config.realtime.providers[providerId] ??
      params.config.realtime.providers[provider.id] ??
      {})
    : (params.config.realtime.providers[provider.id] ?? {});
  const providerConfig = provider.resolveConfig
    ? provider.resolveConfig({ cfg: params.fullConfig, rawConfig })
    : rawConfig;
  if (
    !(provider.isConfiguredAsync
      ? await provider.isConfiguredAsync({ cfg: params.fullConfig, providerConfig })
      : (provider.isConfigured?.({ cfg: params.fullConfig, providerConfig }) ?? false))
  ) {
    throw new Error(`Realtime transcription provider "${provider.id}" is not configured`);
  }
  return { provider, providerConfig };
}

export function buildMeetingSpeakExactUserMessage(text: string): string {
  return [
    "Speak this exact OpenClaw answer to the meeting, without adding, removing, or rephrasing words.",
    `Answer: ${JSON.stringify(text)}`,
  ].join("\n");
}

function formatLogValue(value: string | undefined): string {
  const normalized = value ? truncateUtf16Safe(value.replace(/\s+/g, "_"), 180) : undefined;
  return normalized || "unknown";
}

function resolveProviderModelForLog(params: {
  provider: { defaultModel?: string };
  providerConfig: RealtimeVoiceProviderConfig | RealtimeTranscriptionProviderConfig;
  fallbackModel?: string;
}): string {
  return (
    readLogString(params.providerConfig.model) ??
    readLogString(params.providerConfig.modelId) ??
    readLogString(params.fallbackModel) ??
    readLogString(params.provider.defaultModel) ??
    "provider-default"
  );
}

export function formatMeetingRealtimeVoiceModelLog(params: {
  logScope: string;
  strategy: string;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  fallbackModel?: string;
  audioFormat: MeetingRealtimeAudioFormat;
}): string {
  return [
    `${params.logScope} realtime voice bridge starting: strategy=${formatLogValue(params.strategy)}`,
    `provider=${formatLogValue(params.provider.id)}`,
    `model=${formatLogValue(resolveProviderModelForLog(params))}`,
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

export function formatMeetingAgentAudioModelLog(params: {
  logScope: string;
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
  audioFormat: MeetingRealtimeAudioFormat;
}): string {
  return [
    `${params.logScope} agent audio bridge starting: transcriptionProvider=${formatLogValue(
      params.provider.id,
    )}`,
    `transcriptionModel=${formatLogValue(resolveProviderModelForLog(params))}`,
    "tts=telephony",
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

type MeetingTtsResultLogFields = {
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
  outputFormat?: string;
  sampleRate?: number;
  fallbackFrom?: string;
};

export function formatMeetingAgentTtsResultLog(
  logScope: string,
  prefix: string,
  result: MeetingTtsResultLogFields,
): string {
  return [
    `${logScope} ${prefix} TTS: provider=${formatLogValue(result.provider)}`,
    `model=${formatLogValue(result.providerModel)}`,
    `voice=${formatLogValue(result.providerVoice)}`,
    `outputFormat=${formatLogValue(result.outputFormat)}`,
    `sampleRate=${result.sampleRate ?? "unknown"}`,
    ...(result.fallbackFrom ? [`fallbackFrom=${formatLogValue(result.fallbackFrom)}`] : []),
  ].join(" ");
}

export function formatMeetingTranscriptSummaryLog(
  logScope: string,
  prefix: string,
  text: string,
): string {
  return `${logScope} ${prefix}: chars=${text.length}`;
}

export function normalizeMeetingTtsPromptText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sayExactly = trimmed.match(/^say exactly:\s*(?<text>.+)$/is)?.groups?.text?.trim();
  if (sayExactly) {
    return sayExactly.replace(/^["']|["']$/g, "").trim() || trimmed;
  }
  return trimmed;
}
