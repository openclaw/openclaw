type UnknownRecord = Record<string, unknown>;
export declare function migrateLegacyDreamingPayloadShape(jobs: UnknownRecord[]): {
    changed: boolean;
    rewrittenCount: number;
};
export declare function countStaleDreamingJobs(jobs: UnknownRecord[]): number;
export {};
