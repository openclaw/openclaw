import { resolve2TonyBaseUrl, resolve2TonySharedSecret } from "./worker-status.js";

export type OperatorWorkerTaskState =
  | "accepted"
  | "queued"
  | "started"
  | "retrying"
  | "completed"
  | "dead-letter";

export type OperatorWorkerTaskRecord = {
  taskId: string;
  runId: string;
  type: string;
  priority: "low" | "normal" | "high";
  state: OperatorWorkerTaskState;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  callbackUrl?: string;
  summary?: string;
  failureCode?: string;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type OperatorWorkerTaskEvent = {
  id: string;
  at: number;
  state: OperatorWorkerTaskState;
  summary?: string;
  failureCode?: string;
};

export type OperatorWorkerTaskListSnapshot = {
  tasks: OperatorWorkerTaskRecord[];
  stats: {
    pending: number;
    active: number;
    shuttingDown: boolean;
  };
};

export type OperatorWorkerReadySnapshot = {
  status: "ok" | "not-ready";
  pending: number;
  active: number;
  shuttingDown: boolean;
  auth: {
    enabled: boolean;
    scheme: "bearer" | "none";
  };
  backend: {
    mode: "memory" | "filesystem" | "redis";
    persistenceEnabled: boolean;
    stateFile: string | null;
    recoveredTasks: number;
  };
};

export type OperatorWorkerTaskEventsSnapshot = {
  taskId: string;
  runId?: string;
  events: OperatorWorkerTaskEvent[];
};

export type OperatorWorkerTaskCancelResult = {
  taskId: string;
  cancelled: boolean;
  message: string;
  task: OperatorWorkerTaskRecord | null;
};

class OperatorWorkerClientError extends Error {
  readonly statusCode: number;
  readonly payload: unknown;

  constructor(message: string, statusCode: number, payload?: unknown) {
    super(message);
    this.name = "OperatorWorkerClientError";
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

function resolveWorkerBaseUrl(): string {
  const baseUrl = resolve2TonyBaseUrl();
  if (!baseUrl) {
    throw new OperatorWorkerClientError("2Tony base URL not configured", 503);
  }
  return baseUrl;
}

async function parseWorkerResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      message: text.trim(),
    };
  }
}

function messageFromPayload(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const errorMessage =
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      payload.error !== null &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : null;
    if (errorMessage?.trim()) {
      return errorMessage.trim();
    }

    const directMessage =
      "message" in payload && typeof payload.message === "string" ? payload.message : null;
    if (directMessage?.trim()) {
      return directMessage.trim();
    }
  }

  return fallback;
}

async function requestWorkerJson<T>(
  pathname: string,
  init?: RequestInit,
  acceptedStatusCodes: readonly number[] = [],
): Promise<T> {
  const endpoint = `${resolveWorkerBaseUrl()}${pathname}`;
  const sharedSecret = resolve2TonySharedSecret();
  const response = await fetch(endpoint, {
    ...init,
    headers: {
      accept: "application/json",
      ...(sharedSecret
        ? {
            authorization: `Bearer ${sharedSecret}`,
          }
        : {}),
      ...(init?.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : Array.isArray(init?.headers)
          ? Object.fromEntries(init.headers as Iterable<[string, string]>)
          : ((init?.headers as Record<string, string>) ?? {})),
    },
  });
  const payload = await parseWorkerResponse(response);
  if (!response.ok && !acceptedStatusCodes.includes(response.status)) {
    throw new OperatorWorkerClientError(
      messageFromPayload(payload, `${response.status} ${response.statusText}`),
      response.status,
      payload,
    );
  }
  return payload as T;
}

export function isOperatorWorkerClientError(error: unknown): error is OperatorWorkerClientError {
  return error instanceof OperatorWorkerClientError;
}

export async function listOperatorWorkerTasks(limit = 50): Promise<OperatorWorkerTaskListSnapshot> {
  return await requestWorkerJson<OperatorWorkerTaskListSnapshot>(
    `/tasks?limit=${encodeURIComponent(String(limit))}`,
  );
}

export async function getOperatorWorkerReady(): Promise<OperatorWorkerReadySnapshot> {
  return await requestWorkerJson<OperatorWorkerReadySnapshot>("/ready");
}

export async function getOperatorWorkerTask(taskId: string): Promise<OperatorWorkerTaskRecord> {
  return await requestWorkerJson<OperatorWorkerTaskRecord>(`/tasks/${encodeURIComponent(taskId)}`);
}

export async function getOperatorWorkerTaskEvents(
  taskId: string,
): Promise<OperatorWorkerTaskEventsSnapshot> {
  return await requestWorkerJson<OperatorWorkerTaskEventsSnapshot>(
    `/tasks/${encodeURIComponent(taskId)}/events`,
  );
}

export async function cancelOperatorWorkerTask(
  taskId: string,
): Promise<OperatorWorkerTaskCancelResult> {
  return await requestWorkerJson<OperatorWorkerTaskCancelResult>(
    `/tasks/${encodeURIComponent(taskId)}/cancel`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
    },
    [409],
  );
}
