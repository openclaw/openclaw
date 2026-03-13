export type ExecApprovalRequestPayload = {
  command: string;
  cwd?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
};

export type ExecApprovalRequest = {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision?: string | null;
  resolvedBy?: string | null;
  ts?: number | null;
};

export type ExecApprovalExpired = {
  id: string;
  ts?: number | null;
};

export type ExecApprovalDecisionTarget =
  | { kind: "ready"; entry: ExecApprovalRequest; queue: ExecApprovalRequest[] }
  | { kind: "expired"; queue: ExecApprovalRequest[] }
  | { kind: "missing"; queue: ExecApprovalRequest[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseExecApprovalRequested(payload: unknown): ExecApprovalRequest | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const request = payload.request;
  if (!id || !isRecord(request)) {
    return null;
  }
  const command = typeof request.command === "string" ? request.command.trim() : "";
  if (!command) {
    return null;
  }
  const createdAtMs = typeof payload.createdAtMs === "number" ? payload.createdAtMs : 0;
  const expiresAtMs = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : 0;
  if (!createdAtMs || !expiresAtMs) {
    return null;
  }
  return {
    id,
    request: {
      command,
      cwd: typeof request.cwd === "string" ? request.cwd : null,
      host: typeof request.host === "string" ? request.host : null,
      security: typeof request.security === "string" ? request.security : null,
      ask: typeof request.ask === "string" ? request.ask : null,
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      resolvedPath: typeof request.resolvedPath === "string" ? request.resolvedPath : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
    },
    createdAtMs,
    expiresAtMs,
  };
}

export function parseExecApprovalResolved(payload: unknown): ExecApprovalResolved | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  if (!id) {
    return null;
  }
  return {
    id,
    decision: typeof payload.decision === "string" ? payload.decision : null,
    resolvedBy: typeof payload.resolvedBy === "string" ? payload.resolvedBy : null,
    ts: typeof payload.ts === "number" ? payload.ts : null,
  };
}

export function parseExecApprovalExpired(payload: unknown): ExecApprovalExpired | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  if (!id) {
    return null;
  }
  return {
    id,
    ts: typeof payload.ts === "number" ? payload.ts : null,
  };
}

export function isExecApprovalExpired(entry: ExecApprovalRequest, now = Date.now()): boolean {
  return entry.expiresAtMs <= now;
}

export function pruneExecApprovalQueue(
  queue: ExecApprovalRequest[],
  now = Date.now(),
): ExecApprovalRequest[] {
  return queue.filter((entry) => entry.expiresAtMs > now);
}

export function addExecApproval(
  queue: ExecApprovalRequest[],
  entry: ExecApprovalRequest,
  now = Date.now(),
): ExecApprovalRequest[] {
  const next = pruneExecApprovalQueue(queue, now).filter((item) => item.id !== entry.id);
  next.push(entry);
  return next;
}

export function removeExecApproval(
  queue: ExecApprovalRequest[],
  id: string,
  now = Date.now(),
): ExecApprovalRequest[] {
  return pruneExecApprovalQueue(queue, now).filter((entry) => entry.id !== id);
}

export function resolveExecApprovalDecisionTarget(
  queue: ExecApprovalRequest[],
  id: string,
  now = Date.now(),
): ExecApprovalDecisionTarget {
  const normalizedId = id.trim();
  const nextQueue = pruneExecApprovalQueue(queue, now);
  if (!normalizedId) {
    return { kind: "missing", queue: nextQueue };
  }
  const entry = queue.find((candidate) => candidate.id === normalizedId);
  if (!entry) {
    return { kind: "missing", queue: nextQueue };
  }
  if (isExecApprovalExpired(entry, now)) {
    return { kind: "expired", queue: nextQueue };
  }
  const active = nextQueue.find((candidate) => candidate.id === normalizedId);
  if (!active) {
    return { kind: "missing", queue: nextQueue };
  }
  return { kind: "ready", entry: active, queue: nextQueue };
}
