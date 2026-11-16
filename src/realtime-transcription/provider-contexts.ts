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
  /**
   * True when config or the request names this provider. Absent when the caller is
   * choosing among candidates. A provider can count a fallback credential source
   * only when named, so that source never changes what automatic selection picks.
   */
  selectedExplicitly?: boolean;
};

/** Inputs passed to a provider when creating a transcription session. */
export type RealtimeTranscriptionSessionCreateRequest = RealtimeTranscriptionSessionCallbacks & {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
};
