import type { OpenClawConfig } from "../config/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import type { SpeechProviderId } from "./provider-types.js";
export declare function normalizeSpeechProviderId(providerId: string | undefined): SpeechProviderId | undefined;
export declare function listSpeechProviders(cfg?: OpenClawConfig): SpeechProviderPlugin[];
export declare function getSpeechProvider(providerId: string | undefined, cfg?: OpenClawConfig): SpeechProviderPlugin | undefined;
export declare function canonicalizeSpeechProviderId(providerId: string | undefined, cfg?: OpenClawConfig): SpeechProviderId | undefined;
