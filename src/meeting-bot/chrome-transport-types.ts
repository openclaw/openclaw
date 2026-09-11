import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import type { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import type { MeetingAudioBackendSelection } from "./audio-backend.js";
import type {
  MeetingBrowserJoinSession,
  MeetingPlatformAdapter,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import type { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import type {
  startMeetingRealtimeEngine,
  MeetingRealtimeAudioEngineHandle,
  MeetingRealtimeEngineConfig,
} from "./realtime-engine.js";
import type { createLocalMeetingRealtimeAudioTransport } from "./realtime-local-audio-transport.js";
import type { createNodeMeetingRealtimeAudioTransport } from "./realtime-node-audio-transport.js";
import type { MeetingBrowserHealth, MeetingTranscriptSnapshot } from "./session-types.js";

export type MeetingChromeTransportConfig = MeetingRealtimeEngineConfig & {
  chrome: MeetingRealtimeEngineConfig["chrome"] & {
    audioBackend: MeetingAudioBackendSelection;
    audioBridgeCommand?: string[];
    audioBridgeHealthCommand?: string[];
    audioBufferBytes: number;
    audioInputCommand?: string[];
    audioInputCommandOverride?: string[];
    audioOutputCommand?: string[];
    audioOutputCommandOverride?: string[];
    autoJoin: boolean;
    bargeInCooldownMs: number;
    bargeInInputCommand?: string[];
    bargeInPeakThreshold: number;
    bargeInRmsThreshold: number;
    browserProfile?: string;
    guestName: string;
    joinTimeoutMs: number;
    launch: boolean;
    reuseExistingTab: boolean;
    waitForInCallMs: number;
  };
  chromeNode: { node?: string };
  realtime: MeetingRealtimeEngineConfig["realtime"] & {
    agentId?: string;
    toolPolicy: Parameters<
      typeof createMeetingRealtimeEngineBindings
    >[0]["config"]["realtime"]["toolPolicy"];
  };
};

type MeetingBrowserNodeAdapter = Pick<
  MeetingPlatformAdapter<unknown, string, MeetingBrowserHealth, MeetingTranscriptSnapshot>,
  "displayName" | "nodeCommandName" | "nodeConfigPath"
>;

export type MeetingChromeTransportOptions<
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
> = {
  browserNodeAdapter: MeetingBrowserNodeAdapter;
  isRealtimeRouteReady(mode: Mode, health: Health | undefined): boolean;
  isTalkBackMode(mode: Mode): boolean;
  meetingLabel: string;
  nodeCommandName: string;
  platform: Pick<
    MeetingPlatformAdapter<MeetingBrowserJoinSession<Mode>, Mode, Health, Transcript>,
    "browser" | "browserLabel" | "urls" | "nodeCommandName" | "nodeConfigPath"
  > &
    MeetingPlatformRuntimeMetadata;
  preserveTrackedBrowserOnEngineFailure: boolean;
  // Limit rollback to resources acquired by this attempt; existing platform policy is the default.
  startupFailurePolicy?: "rollback" | "owned";
  runtime: {
    createBindings: typeof createMeetingRealtimeEngineBindings;
    createLocalAudioTransport: typeof createLocalMeetingRealtimeAudioTransport;
    createNodeAudioTransport: typeof createNodeMeetingRealtimeAudioTransport;
    startAgentRealtimeEngine: typeof startMeetingAgentRealtimeEngine;
    startRealtimeEngine: typeof startMeetingRealtimeEngine;
  };
};

export type CommandPairAudioBridge = MeetingRealtimeAudioEngineHandle & { type: "command-pair" };
export type ExternalAudioBridge = { type: "external-command" };

export type MeetingChromeLaunchParams<Config, Mode extends string> = {
  runtime: PluginRuntime;
  config: Config;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  requesterSessionKey?: string;
  mode: Mode;
  trackedTargetId?: string;
  url: string;
  logger: RuntimeLogger;
};

export type NodeAudioBridge = MeetingRealtimeAudioEngineHandle & {
  type: "node-command-pair";
  nodeId: string;
  bridgeId: string;
};

export type MeetingChromeRecoveryParams<Config, Mode extends string> = {
  runtime: PluginRuntime;
  config: Config;
  fullConfig?: OpenClawConfig;
  meetingSessionId?: string;
  mode: Mode;
  nodeId?: string;
  readOnly?: boolean;
  trackedMeetingUrl?: string;
  trackedTargetId?: string;
  transport: "chrome" | "chrome-node";
  timeoutMs?: number;
  url?: string;
};
