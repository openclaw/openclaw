import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBridgeCallbacks,
  RealtimeVoiceGatewayControl,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceTool,
} from "./provider-types.js";

export type RealtimeVoiceProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: RealtimeVoiceProviderConfig;
  /** Host-selected agent scope for account-aware defaults. */
  agentId?: string;
  /** Runtime surface whose defaults are being resolved; omission retains bridge behavior. */
  surface?: "browser-session" | "gateway-relay" | "bridge";
  /** False when the host needs to control when audio input receives a response. */
  autoRespondToAudio?: boolean;
  /** Session requirements used to choose a compatible default model. */
  requiredCapabilities?: Pick<RealtimeVoiceProviderCapabilities, "supportsVideoFrames">;
};

export type RealtimeVoiceProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  /** Host-selected agent scope for provider auth readiness. */
  agentId?: string;
  providerConfig: RealtimeVoiceProviderConfig;
};

export type RealtimeVoiceBridgeCreateRequest = RealtimeVoiceBridgeCallbacks & {
  cfg?: OpenClawConfig;
  /** Host-selected agent scope for provider auth and agent-owned bridge state. */
  agentId?: string;
  providerConfig: RealtimeVoiceProviderConfig;
  audioFormat?: RealtimeVoiceAudioFormat;
  instructions?: string;
  language?: string;
  autoRespondToAudio?: boolean;
  interruptResponseOnInputAudio?: boolean;
  tools?: RealtimeVoiceTool[];
  /** Host-injected agent delegation runner for provider-owned realtime control channels. */
  runAgentConsult?: RealtimeVoiceAgentConsultRunner;
};

export type RealtimeVoiceBrowserSessionCreateRequest = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
  /** Host-injected agent delegation runner for provider-owned realtime control channels. */
  runAgentConsult?: RealtimeVoiceAgentConsultRunner;
} & (
  | { clientControl?: undefined; gatewayControl?: RealtimeVoiceGatewayControl }
  | {
      /** Explicit ownership requires command binding; lifecycle callbacks alone do not select it. */
      clientControl: { owner: "gateway" };
      gatewayControl: RealtimeVoiceGatewayControl &
        Required<Pick<RealtimeVoiceGatewayControl, "bindControl">>;
    }
);
