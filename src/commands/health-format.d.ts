import type { HealthSummary } from "./health.types.js";
export declare function formatHealthCheckFailure(err: unknown, opts?: {
    rich?: boolean;
}): string;
export declare const formatHealthChannelLines: (summary: HealthSummary, opts?: {
    accountMode?: "default" | "all";
    accountIdsByChannel?: Record<string, string[] | undefined>;
}) => string[];
