export declare function getUnsupportedSecretRefSurfacePatterns(): string[];
export type UnsupportedSecretRefConfigCandidate = {
    path: string;
    value: unknown;
};
export declare function collectUnsupportedSecretRefConfigCandidates(raw: unknown): UnsupportedSecretRefConfigCandidate[];
