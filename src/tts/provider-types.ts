import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedTtsConfig, TtsDirectiveOverrides } from "./tts.js";

export type SpeechProviderId = string;

export type SpeechSynthesisTarget = "audio-file" | "voice-note";

export type SpeechProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  config: ResolvedTtsConfig;
};

export type SpeechSynthesisRequest = {
  text: string;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  target: SpeechSynthesisTarget;
  overrides?: TtsDirectiveOverrides;
};

export type SpeechSynthesisResult = {
  audioBuffer: Buffer;
  outputFormat: string;
  fileExtension: string;
  voiceCompatible: boolean;
};

export type SpeechTelephonySynthesisRequest = {
  text: string;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
};

export type SpeechTelephonySynthesisResult = {
  audioBuffer: Buffer;
  outputFormat: string;
  sampleRate: number;
};
