import type { ImageGenerationProviderPlugin, MediaUnderstandingProviderPlugin, MusicGenerationProviderPlugin, RealtimeTranscriptionProviderPlugin, RealtimeVoiceProviderPlugin, SpeechProviderPlugin, VideoGenerationProviderPlugin } from "../types.js";
export type SpeechProviderContractEntry = {
    pluginId: string;
    provider: SpeechProviderPlugin;
};
export type MediaUnderstandingProviderContractEntry = {
    pluginId: string;
    provider: MediaUnderstandingProviderPlugin;
};
export type RealtimeVoiceProviderContractEntry = {
    pluginId: string;
    provider: RealtimeVoiceProviderPlugin;
};
export type RealtimeTranscriptionProviderContractEntry = {
    pluginId: string;
    provider: RealtimeTranscriptionProviderPlugin;
};
export type ImageGenerationProviderContractEntry = {
    pluginId: string;
    provider: ImageGenerationProviderPlugin;
};
export type VideoGenerationProviderContractEntry = {
    pluginId: string;
    provider: VideoGenerationProviderPlugin;
};
export type MusicGenerationProviderContractEntry = {
    pluginId: string;
    provider: MusicGenerationProviderPlugin;
};
export declare function loadVitestSpeechProviderContractRegistry(): SpeechProviderContractEntry[];
export declare function loadVitestMediaUnderstandingProviderContractRegistry(): MediaUnderstandingProviderContractEntry[];
export declare function loadVitestRealtimeVoiceProviderContractRegistry(): RealtimeVoiceProviderContractEntry[];
export declare function loadVitestRealtimeTranscriptionProviderContractRegistry(): RealtimeTranscriptionProviderContractEntry[];
export declare function loadVitestImageGenerationProviderContractRegistry(): ImageGenerationProviderContractEntry[];
export declare function loadVitestVideoGenerationProviderContractRegistry(): VideoGenerationProviderContractEntry[];
export declare function loadVitestMusicGenerationProviderContractRegistry(): MusicGenerationProviderContractEntry[];
