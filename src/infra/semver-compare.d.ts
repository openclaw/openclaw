export type ComparableSemver = {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[] | null;
};
export declare function normalizeLegacyDotBetaVersion(version: string): string;
export declare function parseComparableSemver(version: string | null | undefined, options?: {
    normalizeLegacyDotBeta?: boolean;
}): ComparableSemver | null;
export declare function comparePrereleaseIdentifiers(a: string[] | null, b: string[] | null): number;
export declare function compareComparableSemver(a: ComparableSemver | null, b: ComparableSemver | null): number | null;
