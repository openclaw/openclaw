import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceAgentConsultToolPolicy } from "../talk/agent-consult-tool.js";
import type { RealtimeVoiceTool, RealtimeVoiceToolCallEvent } from "../talk/provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import type { TalkEventInput } from "../talk/talk-events.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";
import type {
  MeetingRealtimeAudioTransport,
  MeetingRealtimeAudioTransportHealth,
} from "./realtime-audio-transport.js";

export type MeetingRuntimePlatform = {
  /** Adapter-owned identity keeps platform names and log prefixes out of core. */
  displayName: string;
  logScope: string;
  sessionIdPrefix: string;
};

export type MeetingRealtimeEngineConfig = {
  chrome: { audioFormat: MeetingRealtimeAudioFormat };
  realtime: {
    strategy: string;
    agentId?: string;
    provider?: string;
    transcriptionProvider?: string;
    voiceProvider?: string;
    model?: string;
    instructions?: string;
    introMessage?: string;
    toolPolicy?: RealtimeVoiceAgentConsultToolPolicy;
    providers: Record<string, Record<string, unknown>>;
  };
};

export type MeetingAgentConsultParams = {
  meetingSessionId: string;
  requesterSessionKey?: string;
  args: unknown;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  /** Meeting-owned cancellation for the active consult. */
  abortSignal?: AbortSignal;
};

export type MeetingRealtimeToolCallParams = {
  strategy: string;
  session: RealtimeVoiceBridgeSession;
  event: RealtimeVoiceToolCallEvent;
  meetingSessionId: string;
  requesterSessionKey?: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  onTalkEvent: (event: TalkEventInput) => void;
};

export type MeetingRealtimeAudioEngineHealth = ReturnType<
  RealtimeVoiceSessionHarness["getHealth"]
> &
  MeetingRealtimeAudioTransportHealth & {
    lastClearAt?: string;
    clearCount?: number;
    bridgeClosed: boolean;
  };

export type MeetingRealtimeAudioEngineHandle = {
  providerId: string;
  speak: (
    instructions?: string,
    assertCurrent?: () => void,
    refreshCurrent?: () => Promise<void>,
  ) => void | Promise<void>;
  getHealth: () => MeetingRealtimeAudioEngineHealth;
  stop: () => Promise<void>;
};

export type MeetingRealtimeEngineParams = {
  config: MeetingRealtimeEngineConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  platform: MeetingRuntimePlatform;
  meetingSessionId: string;
  requesterSessionKey?: string;
  logPrefix?: "node";
  talkSessionId?: string;
  talkContext?: { nodeId: string; bridgeId: string };
  transport: MeetingRealtimeAudioTransport;
  logger: RuntimeLogger;
  providers?: RealtimeVoiceProviderPlugin[];
  consultAgent: (params: MeetingAgentConsultParams) => Promise<{ text: string }>;
  tools: RealtimeVoiceTool[];
  handleToolCall: (params: MeetingRealtimeToolCallParams) => Promise<void>;
};
