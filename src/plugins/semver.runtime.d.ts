export declare const satisfies: (version: string, range: string, options?: {
    includePrerelease?: boolean;
}) => boolean;
export declare const validSemver: (version: string) => string | null;
export declare const validRange: (range: string) => string | null;
