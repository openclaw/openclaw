import type { OpenClawConfig } from "../config/types.js";
import type { TtsMode } from "../config/types.tts.js";
export { normalizeTtsAutoMode } from "./tts-auto-mode.js";
export declare function resolveConfiguredTtsMode(cfg: OpenClawConfig): TtsMode;
export declare function shouldAttemptTtsPayload(params: {
    cfg: OpenClawConfig;
    ttsAuto?: string;
}): boolean;
