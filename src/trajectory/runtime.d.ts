import { type QueuedFileWriter } from "../agents/queued-file-writer.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TrajectoryToolDefinition } from "./types.js";
export { TRAJECTORY_RUNTIME_EVENT_MAX_BYTES, TRAJECTORY_RUNTIME_FILE_MAX_BYTES, resolveTrajectoryFilePath, resolveTrajectoryPointerFilePath, resolveTrajectoryPointerOpenFlags, safeTrajectorySessionFileName, } from "./paths.js";
type TrajectoryRuntimeInit = {
    cfg?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    runId?: string;
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    provider?: string;
    modelId?: string;
    modelApi?: string | null;
    workspaceDir?: string;
    writer?: QueuedFileWriter;
};
type TrajectoryRuntimeRecorder = {
    enabled: true;
    filePath: string;
    recordEvent: (type: string, data?: Record<string, unknown>) => void;
    flush: () => Promise<void>;
};
export declare function toTrajectoryToolDefinitions(tools: ReadonlyArray<{
    name?: string;
    description?: string;
    parameters?: unknown;
}>): TrajectoryToolDefinition[];
export declare function createTrajectoryRuntimeRecorder(params: TrajectoryRuntimeInit): TrajectoryRuntimeRecorder | null;
