import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionSessionCallbacks,
} from "./provider-types.js";

export type RealtimeTranscriptionProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: RealtimeTranscriptionProviderConfig;
};

export type RealtimeTranscriptionProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

/** Inputs passed to a provider when creating a transcription session. */
export type RealtimeTranscriptionSessionCreateRequest = RealtimeTranscriptionSessionCallbacks & {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
};
