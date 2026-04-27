export type OsSummary = {
    platform: NodeJS.Platform;
    arch: string;
    release: string;
    label: string;
};
export declare function resolveOsSummary(): OsSummary;
