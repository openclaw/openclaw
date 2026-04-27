import type { TaskEventRecord, TaskRecord, TaskStatus } from "./task-registry.types.js";
export declare function isTerminalTaskStatus(status: TaskStatus): boolean;
export declare function formatTaskTerminalMessage(task: TaskRecord): string;
export declare function formatTaskBlockedFollowupMessage(task: TaskRecord): string | null;
export declare function formatTaskStateChangeMessage(task: TaskRecord, event: TaskEventRecord): string | null;
export declare function shouldAutoDeliverTaskTerminalUpdate(task: TaskRecord): boolean;
export declare function shouldAutoDeliverTaskStateChange(task: TaskRecord): boolean;
export declare function shouldSuppressDuplicateTerminalDelivery(params: {
    task: TaskRecord;
    preferredTaskId?: string;
}): boolean;
