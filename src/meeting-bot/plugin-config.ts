import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  buildMeetingConfigAudioCommands,
  resolveMeetingChromeConfig,
  resolveMeetingRealtimeConfig,
} from "../plugin-sdk/meeting-config.js";
import type { OpenClawPluginConfigSchema } from "../plugins/plugin-config-schema.types.js";
import type { RealtimeVoiceAgentConsultToolPolicy } from "../talk/agent-consult-tool.js";
import type { MeetingAudioBackendSelection } from "./audio-backend.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";
import type { MeetingRealtimeEngineConfig } from "./realtime-engine.js";

type MeetingPluginMode = "agent" | "bidi" | "transcribe";

export type MeetingPluginConfig = MeetingRealtimeEngineConfig & {
  enabled: boolean;
  defaultMode: MeetingPluginMode;
  chrome: MeetingRealtimeEngineConfig["chrome"] & {
    audioBackend: MeetingAudioBackendSelection;
    audioBufferBytes: number;
    launch: boolean;
    browserProfile?: string;
    guestName: string;
    reuseExistingTab: boolean;
    autoJoin: boolean;
    joinTimeoutMs: number;
    waitForInCallMs: number;
    audioInputCommand: string[];
    audioOutputCommand: string[];
    audioInputCommandOverride?: string[];
    audioOutputCommandOverride?: string[];
    bargeInInputCommand?: string[];
    bargeInRmsThreshold: number;
    bargeInPeakThreshold: number;
    bargeInCooldownMs: number;
  };
  chromeNode: { node?: string };
  realtime: MeetingRealtimeEngineConfig["realtime"] & {
    strategy: "agent" | "bidi";
    toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  };
};

type MeetingPluginConfigOptions = {
  defaultRealtimeInstructions: string;
  resolveGatewayOperationTimeoutMs(config: MeetingPluginConfig): number;
};

const DEFAULT_AUDIO_BUFFER_BYTES = 4_096;
const DEFAULT_AUDIO_FORMAT: MeetingRealtimeAudioFormat = "pcm16-24khz";
const DEFAULT_MODE_HELP =
  "Agent consults OpenClaw, bidi uses direct realtime voice, and transcribe observes only.";
const CHROME_NODE_HELP = "Node id/name/IP that owns Chrome and the native virtual-audio backend.";

function resolveMode(value: unknown): MeetingPluginMode {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "agent" || normalized === "bidi" || normalized === "transcribe"
    ? normalized
    : "agent";
}

function resolveAudioFormat(value: unknown): MeetingRealtimeAudioFormat {
  const normalized = normalizeOptionalLowercaseString(value)?.replaceAll("_", "-");
  return normalized === "g711-ulaw-8khz" ? normalized : DEFAULT_AUDIO_FORMAT;
}

export function createMeetingPluginConfigSchema(options: MeetingPluginConfigOptions) {
  const defaultAudioRuntime = buildMeetingConfigAudioCommands(
    "auto",
    DEFAULT_AUDIO_FORMAT,
    DEFAULT_AUDIO_BUFFER_BYTES,
  );
  const resolveConfig = (input: unknown): MeetingPluginConfig => {
    const raw = asRecord(input);
    const chrome = asRecord(raw.chrome);
    const chromeNode = asRecord(raw.chromeNode);
    const realtime = asRecord(raw.realtime);
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      defaultMode: resolveMode(raw.defaultMode),
      chrome: resolveMeetingChromeConfig(chrome, {
        resolveAudioFormat: () => resolveAudioFormat(chrome.audioFormat),
        waitForInCallMs: 60_000,
      }),
      chromeNode: { node: normalizeOptionalString(chromeNode.node) },
      realtime: resolveMeetingRealtimeConfig(realtime, {
        instructions: options.defaultRealtimeInstructions,
        transcriptionProvider: "openai",
      }),
    };
  };
  const configSchema = {
    parse: resolveConfig,
    uiHints: {
      defaultMode: { label: "Default Mode", help: DEFAULT_MODE_HELP },
      "chrome.audioBackend": {
        label: "Chrome Audio Backend",
        help: "Auto selects BlackHole 2ch on macOS or PipeWire-Pulse on Linux.",
      },
      "chrome.browserProfile": { label: "Chrome Profile", advanced: true },
      "chrome.guestName": { label: "Guest Name" },
      "chrome.waitForInCallMs": { label: "Wait For In-Call (ms)", advanced: true },
      "chrome.audioInputCommand": { label: "Audio Input Command", advanced: true },
      "chrome.audioOutputCommand": { label: "Audio Output Command", advanced: true },
      "chromeNode.node": { label: "Chrome Node", help: CHROME_NODE_HELP, advanced: true },
      "realtime.transcriptionProvider": { label: "Realtime Transcription Provider" },
      "realtime.voiceProvider": { label: "Bidi Voice Provider" },
      "realtime.model": { label: "Bidi Realtime Model", advanced: true },
      "realtime.instructions": { label: "Realtime Instructions", advanced: true },
      "realtime.introMessage": { label: "Realtime Intro Message" },
      "realtime.agentId": { label: "Realtime Consult Agent", advanced: true },
      "realtime.toolPolicy": { label: "Realtime Tool Policy", advanced: true },
    },
  } satisfies OpenClawPluginConfigSchema;
  return {
    configSchema,
    defaultAudioInputCommand: defaultAudioRuntime.inputCommand,
    defaultAudioOutputCommand: defaultAudioRuntime.outputCommand,
    resolveConfig,
    resolveGatewayOperationTimeoutMs: (config: MeetingPluginConfig) =>
      options.resolveGatewayOperationTimeoutMs(config),
  };
}
