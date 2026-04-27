import type { FollowupRun } from "./types.js";
export declare function rememberFollowupDrainCallback(key: string, runFollowup: (run: FollowupRun) => Promise<void>): void;
export declare function clearFollowupDrainCallback(key: string): void;
/** Restart the drain for `key` if it is currently idle, using the stored callback. */
export declare function kickFollowupDrainIfIdle(key: string): void;
export declare function resolveFollowupAuthorizationKey(run: FollowupRun["run"]): string;
export declare function scheduleFollowupDrain(key: string, runFollowup: (run: FollowupRun) => Promise<void>): void;
