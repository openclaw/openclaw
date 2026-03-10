import fs from "node:fs/promises";
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
  // Prefer a more precise error surface than readJsonFile for callers that need
  // to distinguish missing files from malformed JSON.
  let raw: unknown;
  try {
    const text = await fs.readFile(filePath, "utf8");
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, error: "TASK_STATUS_INVALID_JSON" };
    }
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      return { ok: false, error: "TASK_STATUS_FILE_MISSING" };
    }
    // Fall back to the generic helper for non-ENOENT errors so future
    // enhancements there (metrics, logging) still apply.
    const fallback = await readJsonFile<unknown>(filePath);
    if (!fallback) {
      return { ok: false, error: "TASK_STATUS_FILE_UNREADABLE" };
    }
    raw = fallback;
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
    const { current, total, percentage, etaSeconds } = data.progress;
    if (current !== undefined && typeof current !== "number") {
      return { ok: false, error: "TASK_STATUS_INVALID_PROGRESS_CURRENT" };
    }
    if (total !== undefined && typeof total !== "number") {
      return { ok: false, error: "TASK_STATUS_INVALID_PROGRESS_TOTAL" };
    }
    if (percentage !== undefined && typeof percentage !== "number") {
      return { ok: false, error: "TASK_STATUS_INVALID_PROGRESS_PERCENTAGE" };
    }
    if (etaSeconds !== undefined && typeof etaSeconds !== "number") {
      return { ok: false, error: "TASK_STATUS_INVALID_PROGRESS_ETA_SECONDS" };
    }
  }

  return { ok: true, status: data as OpenClawTaskStatusFile };
}

