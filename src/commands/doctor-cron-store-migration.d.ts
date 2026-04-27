type CronStoreIssueKey = "jobId" | "missingId" | "nonStringId" | "legacyScheduleString" | "legacyScheduleCron" | "legacyPayloadKind" | "legacyPayloadProvider" | "legacyTopLevelPayloadFields" | "legacyTopLevelDeliveryFields" | "legacyDeliveryMode";
type CronStoreIssues = Partial<Record<CronStoreIssueKey, number>>;
type NormalizeCronStoreJobsResult = {
    issues: CronStoreIssues;
    jobs: Array<Record<string, unknown>>;
    mutated: boolean;
};
export declare function normalizeStoredCronJobs(jobs: Array<Record<string, unknown>>): NormalizeCronStoreJobsResult;
export {};
