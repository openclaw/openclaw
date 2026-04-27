export declare function concatOptionalTextSegments(params: {
    left?: string;
    right?: string;
    separator?: string;
}): string | undefined;
export declare function joinPresentTextSegments(segments: ReadonlyArray<string | null | undefined>, options?: {
    separator?: string;
    trim?: boolean;
}): string | undefined;
