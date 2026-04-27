import { type UpdateCheckResult } from "../infra/update-check.js";
export declare function getUpdateCheckResult(params: {
    timeoutMs: number;
    fetchGit: boolean;
    includeRegistry: boolean;
}): Promise<UpdateCheckResult>;
export type UpdateAvailability = {
    available: boolean;
    hasGitUpdate: boolean;
    hasRegistryUpdate: boolean;
    latestVersion: string | null;
    gitBehind: number | null;
};
export declare function resolveUpdateAvailability(update: UpdateCheckResult): UpdateAvailability;
export declare function formatUpdateAvailableHint(update: UpdateCheckResult): string | null;
export declare function formatUpdateOneLiner(update: UpdateCheckResult): string;
