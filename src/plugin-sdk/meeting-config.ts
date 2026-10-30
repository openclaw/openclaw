import {
  asPositiveFiniteNumber,
  resolvePositiveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  resolveMeetingAudioRuntimeForFormat,
  type MeetingAudioBackendSelection,
} from "../meeting-bot/audio-backend.js";
import type { MeetingRealtimeAudioFormat } from "../meeting-bot/realtime-audio-format.js";
import { resolveRealtimeVoiceAgentConsultToolPolicy } from "../talk/agent-consult-tool.js";

/** Build config defaults for a local or remote audio host without starting its transport. */
export function buildMeetingConfigAudioCommands(
  backend: MeetingAudioBackendSelection,
  format: MeetingRealtimeAudioFormat,
  bufferBytes: number,
) {
  return resolveMeetingAudioRuntimeForFormat({
    backend,
    format,
    bufferBytes,
    platform:
      backend === "pipewire-pulse" || (backend === "auto" && process.platform === "linux")
        ? "linux"
        : "darwin",
  });
}

/** Shared Chrome meeting fields; platform adapters retain their format aliases and timeout. */
export function resolveMeetingChromeConfig(
  chrome: Record<string, unknown>,
  options: {
    resolveAudioFormat(hasCustomCommands: boolean): MeetingRealtimeAudioFormat;
    waitForInCallMs: number;
  },
) {
  const audioBufferBytes = Math.max(
    17,
    Math.trunc(asPositiveFiniteNumber(chrome.audioBufferBytes) ?? 4_096),
  );
  const backend = normalizeOptionalLowercaseString(chrome.audioBackend)?.replaceAll("_", "-");
  const audioBackend: MeetingAudioBackendSelection =
    backend === "blackhole-2ch" || backend === "pipewire-pulse" ? backend : "auto";
  const audioInputCommandOverride = normalizeOptionalTrimmedStringList(chrome.audioInputCommand);
  const audioOutputCommandOverride = normalizeOptionalTrimmedStringList(chrome.audioOutputCommand);
  const audioFormat = options.resolveAudioFormat(
    audioInputCommandOverride !== undefined || audioOutputCommandOverride !== undefined,
  );
  const commands = buildMeetingConfigAudioCommands(audioBackend, audioFormat, audioBufferBytes);
  return {
    audioBackend,
    audioFormat,
    audioBufferBytes,
    launch: typeof chrome.launch === "boolean" ? chrome.launch : true,
    browserProfile: normalizeOptionalString(chrome.browserProfile),
    guestName: normalizeOptionalString(chrome.guestName) ?? "OpenClaw Agent",
    reuseExistingTab: typeof chrome.reuseExistingTab === "boolean" ? chrome.reuseExistingTab : true,
    autoJoin: typeof chrome.autoJoin === "boolean" ? chrome.autoJoin : true,
    joinTimeoutMs: resolvePositiveTimerTimeoutMs(chrome.joinTimeoutMs, 30_000),
    waitForInCallMs: resolvePositiveTimerTimeoutMs(chrome.waitForInCallMs, options.waitForInCallMs),
    audioInputCommand: audioInputCommandOverride ?? commands.inputCommand,
    audioOutputCommand: audioOutputCommandOverride ?? commands.outputCommand,
    audioInputCommandOverride,
    audioOutputCommandOverride,
    bargeInInputCommand: normalizeOptionalTrimmedStringList(chrome.bargeInInputCommand),
    bargeInRmsThreshold: asPositiveFiniteNumber(chrome.bargeInRmsThreshold) ?? 650,
    bargeInPeakThreshold: asPositiveFiniteNumber(chrome.bargeInPeakThreshold) ?? 2_500,
    bargeInCooldownMs: resolvePositiveTimerTimeoutMs(chrome.bargeInCooldownMs, 900),
  };
}

/** Shared realtime meeting fields; adapters supply their instructions and transcription default. */
export function resolveMeetingRealtimeConfig(
  realtime: Record<string, unknown>,
  options: { instructions: string; transcriptionProvider: string },
) {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(asRecord(realtime.providers))) {
    const id = normalizeOptionalLowercaseString(key);
    if (id) {
      providers[id] = asRecord(entry);
    }
  }
  const strategy: "bidi" | "agent" =
    normalizeOptionalLowercaseString(realtime.strategy) === "bidi" ? "bidi" : "agent";
  return {
    strategy,
    provider: normalizeOptionalString(realtime.provider) ?? "openai",
    transcriptionProvider:
      normalizeOptionalString(realtime.transcriptionProvider) ?? options.transcriptionProvider,
    voiceProvider: normalizeOptionalString(realtime.voiceProvider),
    model: normalizeOptionalString(realtime.model),
    instructions: normalizeOptionalString(realtime.instructions) ?? options.instructions,
    introMessage:
      typeof realtime.introMessage === "string"
        ? realtime.introMessage.trim()
        : "Say exactly: I'm here and listening.",
    agentId: normalizeOptionalString(realtime.agentId),
    toolPolicy: resolveRealtimeVoiceAgentConsultToolPolicy(realtime.toolPolicy, "safe-read-only"),
    providers,
  };
}
