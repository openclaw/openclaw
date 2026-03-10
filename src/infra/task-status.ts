import { readJsonFile } from "./json-files.js";

export type OpenClawTaskStatusPhase =
  | "pending"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed";

export type OpenClawTaskStatusProgress = {
  current?: number;
  total?: number;
  percentage?: number;
  etaSeconds?: number;
};

export type OpenClawTaskStatusHistoryEntry = {
  at: string;
  event: string;
  [key: string]: unknown;
};

export type OpenClawTaskStatusRequiresInput = {
  message: string;
  options?: Array<{
    id: string;
    label: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
} | null;

export type OpenClawTaskStatusV1 = {
  $schema?: "openclaw-task-status-v1";
  taskId: string;
  taskType?: "one-shot" | "recurring";
  status: OpenClawTaskStatusPhase;
  progress?: OpenClawTaskStatusProgress;
  message?: string;
  /**
   * Optional machine-readable error information when status === "failed".
   */
  errorCode?: string;
  errorDetails?: unknown;
  requiresInput?: OpenClawTaskStatusRequiresInput;
  history?: OpenClawTaskStatusHistoryEntry[];
  updatedAt: string;
  /**
   * Arbitrary extensions for task-specific payloads.
   */
  extensions?: Record<string, unknown>;
};

export type OpenClawTaskStatusFile = OpenClawTaskStatusV1;

export type OpenClawTaskStatusReadResult =
  | { ok: true; status: OpenClawTaskStatusFile }
  | { ok: false; error: string };

export async function readTaskStatusFile(
  filePath: string,
): Promise<OpenClawTaskStatusReadResult> {
  const raw = await readJsonFile<unknown>(filePath);
  if (!raw) {
    return { ok: false, error: "TASK_STATUS_FILE_MISSING_OR_UNREADABLE" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "TASK_STATUS_INVALID_ROOT" };
  }
  const data = raw as Partial<OpenClawTaskStatusV1>;
  if (typeof data.taskId !== "string" || data.taskId.length === 0) {
    return { ok: false, error: "TASK_STATUS_MISSING_TASK_ID" };
  }
  if (typeof data.status !== "string") {
    return { ok: false, error: "TASK_STATUS_MISSING_STATUS" };
  }
  if (typeof data.updatedAt !== "string" || data.updatedAt.length === 0) {
    return { ok: false, error: "TASK_STATUS_MISSING_UPDATED_AT" };
  }

  const allowedStatuses: OpenClawTaskStatusPhase[] = [
    "pending",
    "running",
    "waiting_for_input",
    "completed",
    "failed",
  ];
  if (!allowedStatuses.includes(data.status as OpenClawTaskStatusPhase)) {
    return { ok: false, error: "TASK_STATUS_INVALID_STATUS" };
  }

  if (data.progress) {
    const { current, total, percentage } = data.progress;
    if (current !== undefined && typeof current !== "number") {
      return { ok: false, error: "TASK_STATUS_INVALID_PROGRESS_CURRENT" };
    }
    if (total !== undefined && typeof total !== "number") {
      return { ok: false, error: "TASK_STATUS_INVALID_PROGRESS_TOTAL" };
    }
    if (percentage !== undefined && typeof percentage !== "number") {
      return { ok: false, error: "TASK_STATUS_INVALID_PROGRESS_PERCENTAGE" };
    }
  }

  return { ok: true, status: data as OpenClawTaskStatusFile };
}

