import { type DiagnosticMemoryUsage } from "../infra/diagnostic-events.js";
export type DiagnosticMemoryThresholds = {
    rssWarningBytes?: number;
    rssCriticalBytes?: number;
    heapUsedWarningBytes?: number;
    heapUsedCriticalBytes?: number;
    rssGrowthWarningBytes?: number;
    rssGrowthCriticalBytes?: number;
    growthWindowMs?: number;
    pressureRepeatMs?: number;
};
export declare function emitDiagnosticMemorySample(options?: {
    now?: number;
    memoryUsage?: NodeJS.MemoryUsage;
    uptimeMs?: number;
    thresholds?: DiagnosticMemoryThresholds;
    emitSample?: boolean;
}): DiagnosticMemoryUsage;
export declare function resetDiagnosticMemoryForTest(): void;
