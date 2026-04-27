import { resolveEmbeddedSessionLane } from "../../../agents/pi-embedded-runner/lanes.js";
import { clearCommandLane } from "../../../process/command-queue.js";
export type ClearSessionQueueResult = {
    followupCleared: number;
    laneCleared: number;
    keys: string[];
};
declare const defaultQueueCleanupDeps: {
    resolveEmbeddedSessionLane: typeof resolveEmbeddedSessionLane;
    clearCommandLane: typeof clearCommandLane;
};
export declare const __testing: {
    setDepsForTests(deps: Partial<typeof defaultQueueCleanupDeps> | undefined): void;
    resetDepsForTests(): void;
};
export declare function clearSessionQueues(keys: Array<string | undefined>): ClearSessionQueueResult;
export {};
