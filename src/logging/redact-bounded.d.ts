export declare const REDACT_REGEX_CHUNK_THRESHOLD = 32768;
export declare const REDACT_REGEX_CHUNK_SIZE = 16384;
type BoundedRedactOptions = {
    chunkThreshold?: number;
    chunkSize?: number;
};
export declare function replacePatternBounded(text: string, pattern: RegExp, replacer: Parameters<string["replace"]>[1], options?: BoundedRedactOptions): string;
export {};
