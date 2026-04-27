import type { MusicGenerationIgnoredOverride, MusicGenerationNormalization, MusicGenerationOutputFormat, MusicGenerationProvider, MusicGenerationSourceImage } from "./types.js";
export type ResolvedMusicGenerationOverrides = {
    lyrics?: string;
    instrumental?: boolean;
    durationSeconds?: number;
    format?: MusicGenerationOutputFormat;
    ignoredOverrides: MusicGenerationIgnoredOverride[];
    normalization?: MusicGenerationNormalization;
};
export declare function resolveMusicGenerationOverrides(params: {
    provider: MusicGenerationProvider;
    model: string;
    lyrics?: string;
    instrumental?: boolean;
    durationSeconds?: number;
    format?: MusicGenerationOutputFormat;
    inputImages?: MusicGenerationSourceImage[];
}): ResolvedMusicGenerationOverrides;
