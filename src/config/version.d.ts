export type OpenClawVersion = {
    major: number;
    minor: number;
    patch: number;
    revision: number | null;
    prerelease: string[] | null;
};
export declare function parseOpenClawVersion(raw: string | null | undefined): OpenClawVersion | null;
export declare function normalizeOpenClawVersionBase(raw: string | null | undefined): string | null;
export declare function isSameOpenClawStableFamily(a: string | null | undefined, b: string | null | undefined): boolean;
export declare function compareOpenClawVersions(a: string | null | undefined, b: string | null | undefined): number | null;
export declare function shouldWarnOnTouchedVersion(current: string | null | undefined, touched: string | null | undefined): boolean;
