import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { type AgentInternalEvent } from "../internal-events.js";
export type MediaGenerationTaskHandle = {
    taskId: string;
    runId: string;
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
    taskLabel: string;
};
type CreateMediaGenerationTaskRunParams = {
    sessionKey?: string;
    requesterOrigin?: DeliveryContext;
    prompt: string;
    providerId?: string;
};
type RecordMediaGenerationTaskProgressParams = {
    handle: MediaGenerationTaskHandle | null;
    progressSummary: string;
    eventSummary?: string;
};
type CompleteMediaGenerationTaskRunParams = {
    handle: MediaGenerationTaskHandle | null;
    provider: string;
    model: string;
    count: number;
    paths: string[];
};
type FailMediaGenerationTaskRunParams = {
    handle: MediaGenerationTaskHandle | null;
    error: unknown;
};
type WakeMediaGenerationTaskCompletionParams = {
    config?: OpenClawConfig;
    handle: MediaGenerationTaskHandle | null;
    status: "ok" | "error";
    statusLabel: string;
    result: string;
    mediaUrls?: string[];
    statsLine?: string;
};
export declare function createMediaGenerationTaskRun(params: {
    sessionKey?: string;
    requesterOrigin?: DeliveryContext;
    prompt: string;
    providerId?: string;
    toolName: string;
    taskKind: string;
    label: string;
    queuedProgressSummary: string;
}): MediaGenerationTaskHandle | null;
export declare function recordMediaGenerationTaskProgress(params: {
    handle: MediaGenerationTaskHandle | null;
    progressSummary: string;
    eventSummary?: string;
}): void;
export declare function completeMediaGenerationTaskRun(params: {
    handle: MediaGenerationTaskHandle | null;
    provider: string;
    model: string;
    count: number;
    paths: string[];
    generatedLabel: string;
}): void;
export declare function failMediaGenerationTaskRun(params: {
    handle: MediaGenerationTaskHandle | null;
    error: unknown;
    progressSummary: string;
}): void;
export declare function wakeMediaGenerationTaskCompletion(params: {
    config?: OpenClawConfig;
    handle: MediaGenerationTaskHandle | null;
    status: "ok" | "error";
    statusLabel: string;
    result: string;
    mediaUrls?: string[];
    statsLine?: string;
    eventSource: AgentInternalEvent["source"];
    announceType: string;
    toolName: string;
    completionLabel: string;
}): Promise<void>;
export declare function createMediaGenerationTaskLifecycle(params: {
    toolName: string;
    taskKind: string;
    label: string;
    queuedProgressSummary: string;
    generatedLabel: string;
    failureProgressSummary: string;
    eventSource: AgentInternalEvent["source"];
    announceType: string;
    completionLabel: string;
}): {
    createTaskRun(runParams: CreateMediaGenerationTaskRunParams): MediaGenerationTaskHandle | null;
    recordTaskProgress(progressParams: RecordMediaGenerationTaskProgressParams): void;
    completeTaskRun(completionParams: CompleteMediaGenerationTaskRunParams): void;
    failTaskRun(failureParams: FailMediaGenerationTaskRunParams): void;
    wakeTaskCompletion(completionParams: WakeMediaGenerationTaskCompletionParams): Promise<void>;
};
export {};
