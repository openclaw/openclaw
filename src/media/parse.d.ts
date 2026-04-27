export declare const MEDIA_TOKEN_RE: RegExp;
export type ParsedMediaOutputSegment = {
    type: "text";
    text: string;
} | {
    type: "media";
    url: string;
};
export declare function normalizeMediaSource(src: string): string;
export declare function splitMediaFromOutput(raw: string): {
    text: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    audioAsVoice?: boolean;
    segments?: ParsedMediaOutputSegment[];
};
