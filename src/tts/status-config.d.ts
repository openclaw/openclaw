import type { OpenClawConfig } from "../config/types.js";
import type { TtsAutoMode, TtsProvider } from "../config/types.tts.js";
type TtsStatusSnapshot = {
    autoMode: TtsAutoMode;
    provider: TtsProvider;
    maxLength: number;
    summarize: boolean;
};
export declare function resolveStatusTtsSnapshot(params: {
    cfg: OpenClawConfig;
    sessionAuto?: string;
}): TtsStatusSnapshot | null;
export {};
