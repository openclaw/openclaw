import type { TaskRecord } from "./task-registry.types.js";
export declare const TASK_STATUS_RECENT_WINDOW_MS: number;
export declare const TASK_STATUS_TITLE_MAX_CHARS = 80;
export declare const TASK_STATUS_DETAIL_MAX_CHARS = 120;
export declare function sanitizeTaskStatusText(value: unknown, opts?: {
    errorContext?: boolean;
    maxChars?: number;
}): string;
export declare function formatTaskStatusTitleText(value: unknown, fallback?: string): string;
export declare function formatTaskStatusTitle(task: TaskRecord): string;
export declare function formatTaskStatusDetail(task: TaskRecord): string | undefined;
export type TaskStatusSnapshot = {
    latest?: TaskRecord;
    focus?: TaskRecord;
    visible: TaskRecord[];
    active: TaskRecord[];
    recentTerminal: TaskRecord[];
    activeCount: number;
    totalCount: number;
    recentFailureCount: number;
};
export declare function buildTaskStatusSnapshot(tasks: TaskRecord[], opts?: {
    now?: number;
}): TaskStatusSnapshot;
