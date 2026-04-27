export type VoiceWakeConfig = {
    triggers: string[];
    updatedAtMs: number;
};
export declare function defaultVoiceWakeTriggers(): string[];
export declare function loadVoiceWakeConfig(baseDir?: string): Promise<VoiceWakeConfig>;
export declare function setVoiceWakeTriggers(triggers: string[], baseDir?: string): Promise<VoiceWakeConfig>;
