import type { GatewayBrowserClient, GatewayHelloOk } from "../gateway.ts";

export type MemoryAuditAction = "add" | "edit" | "delete" | "move";
export type MemoryAuditSurfaceKind =
  | "agent-memory"
  | "user-profile"
  | "tool-notes"
  | "shared-memory";
export type MemoryAuditSuggestionStatus = "pending" | "applied" | "rejected" | "conflict";

export type MemoryAuditSuggestionTarget = {
  surfaceId: string;
  kind: MemoryAuditSurfaceKind;
  path: string;
  workspaceDir: string;
  agentId?: string;
};

export type MemoryAuditSuggestion = {
  id: string;
  status: MemoryAuditSuggestionStatus;
  action: MemoryAuditAction;
  text: string;
  rationale: string;
  confidence: number;
  source?: MemoryAuditSuggestionTarget & {
    startLine: number;
    endLine: number;
    hash: string;
  };
  target: MemoryAuditSuggestionTarget;
  reviewerAgentId?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  rejectedAt?: string;
  conflict?: string;
};

export type MemoryAuditSuggestions = {
  agentId?: string;
  workspaces: string[];
  total: number;
  pending: number;
  applied: number;
  rejected: number;
  conflict: number;
  suggestions: MemoryAuditSuggestion[];
};

type MemoryAuditActionPayload = {
  action?: unknown;
  applied?: unknown;
  rejected?: unknown;
  conflict?: unknown;
};

export type MemoryAuditState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  memoryAuditLoading: boolean;
  memoryAuditError: string | null;
  memoryAuditSuggestions: MemoryAuditSuggestions | null;
  memoryAuditActionId: string | null;
  memoryAuditActionMessage: { kind: "success" | "error"; text: string } | null;
  lastError: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePossiblyEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeFiniteInt(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
}

function normalizeAction(value: unknown): MemoryAuditAction | null {
  return value === "add" || value === "edit" || value === "delete" || value === "move"
    ? value
    : null;
}

function normalizeKind(value: unknown): MemoryAuditSurfaceKind | null {
  return value === "agent-memory" ||
    value === "user-profile" ||
    value === "tool-notes" ||
    value === "shared-memory"
    ? value
    : null;
}

function normalizeStatus(value: unknown): MemoryAuditSuggestionStatus | null {
  return value === "pending" || value === "applied" || value === "rejected" || value === "conflict"
    ? value
    : null;
}

function normalizeTarget(value: unknown): MemoryAuditSuggestionTarget | null {
  const record = asRecord(value);
  const surfaceId = normalizeTrimmedString(record?.surfaceId);
  const kind = normalizeKind(record?.kind);
  const path = normalizeTrimmedString(record?.path);
  const workspaceDir = normalizeTrimmedString(record?.workspaceDir);
  if (!surfaceId || !kind || !path || !workspaceDir) {
    return null;
  }
  return {
    surfaceId,
    kind,
    path,
    workspaceDir,
    ...(normalizeTrimmedString(record?.agentId)
      ? { agentId: normalizeTrimmedString(record?.agentId) }
      : {}),
  };
}

function normalizeSource(value: unknown): MemoryAuditSuggestion["source"] | undefined {
  const record = asRecord(value);
  const target = normalizeTarget(record);
  const hash = normalizeTrimmedString(record?.hash);
  if (!target || !hash) {
    return undefined;
  }
  return {
    ...target,
    startLine: Math.max(1, normalizeFiniteInt(record?.startLine, 1)),
    endLine: Math.max(1, normalizeFiniteInt(record?.endLine, 1)),
    hash,
  };
}

function normalizeSuggestion(value: unknown): MemoryAuditSuggestion | null {
  const record = asRecord(value);
  const id = normalizeTrimmedString(record?.id);
  const status = normalizeStatus(record?.status);
  const action = normalizeAction(record?.action);
  const text = normalizePossiblyEmptyString(record?.text);
  const rationale = normalizeTrimmedString(record?.rationale);
  const target = normalizeTarget(record?.target);
  const createdAt = normalizeTrimmedString(record?.createdAt);
  const updatedAt = normalizeTrimmedString(record?.updatedAt);
  if (
    !id ||
    !status ||
    !action ||
    text === undefined ||
    (action !== "delete" && text.length === 0) ||
    !rationale ||
    !target ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  return {
    id,
    status,
    action,
    text,
    rationale,
    confidence: normalizeConfidence(record?.confidence),
    target,
    createdAt,
    updatedAt,
    ...(normalizeSource(record?.source) ? { source: normalizeSource(record?.source) } : {}),
    ...(normalizeTrimmedString(record?.reviewerAgentId)
      ? { reviewerAgentId: normalizeTrimmedString(record?.reviewerAgentId) }
      : {}),
    ...(normalizeTrimmedString(record?.appliedAt)
      ? { appliedAt: normalizeTrimmedString(record?.appliedAt) }
      : {}),
    ...(normalizeTrimmedString(record?.rejectedAt)
      ? { rejectedAt: normalizeTrimmedString(record?.rejectedAt) }
      : {}),
    ...(normalizeTrimmedString(record?.conflict)
      ? { conflict: normalizeTrimmedString(record?.conflict) }
      : {}),
  };
}

export function normalizeMemoryAuditSuggestions(value: unknown): MemoryAuditSuggestions {
  const record = asRecord(value);
  const suggestions = Array.isArray(record?.suggestions)
    ? record.suggestions
        .map((entry) => normalizeSuggestion(entry))
        .filter((entry): entry is MemoryAuditSuggestion => entry !== null)
    : [];
  return {
    ...(normalizeTrimmedString(record?.agentId)
      ? { agentId: normalizeTrimmedString(record?.agentId) }
      : {}),
    workspaces: normalizeStringArray(record?.workspaces),
    total: normalizeFiniteInt(record?.total, suggestions.length),
    pending: normalizeFiniteInt(
      record?.pending,
      suggestions.filter((entry) => entry.status === "pending").length,
    ),
    applied: normalizeFiniteInt(
      record?.applied,
      suggestions.filter((entry) => entry.status === "applied").length,
    ),
    rejected: normalizeFiniteInt(
      record?.rejected,
      suggestions.filter((entry) => entry.status === "rejected").length,
    ),
    conflict: normalizeFiniteInt(
      record?.conflict,
      suggestions.filter((entry) => entry.status === "conflict").length,
    ),
    suggestions,
  };
}

function hasGatewayMethod(state: MemoryAuditState, method: string): boolean | null {
  const methods = state.hello?.features?.methods;
  if (!Array.isArray(methods)) {
    return null;
  }
  return methods.includes(method);
}

function methodUnavailableMessage(method: string): string {
  return `Memory Audit is unavailable on this Gateway. Missing method: ${method}`;
}

export async function loadMemoryAuditSuggestions(state: MemoryAuditState): Promise<void> {
  if (!state.client || !state.connected || state.memoryAuditLoading) {
    return;
  }
  const method = "doctor.memory.auditSuggestions";
  if (hasGatewayMethod(state, method) === false) {
    state.memoryAuditSuggestions = null;
    state.memoryAuditError = methodUnavailableMessage(method);
    state.memoryAuditLoading = false;
    return;
  }
  state.memoryAuditLoading = true;
  state.memoryAuditError = null;
  try {
    const payload = await state.client.request(method, {});
    state.memoryAuditSuggestions = normalizeMemoryAuditSuggestions(payload);
  } catch (err) {
    state.memoryAuditError = String(err);
  } finally {
    state.memoryAuditLoading = false;
  }
}

function buildActionMessage(action: "apply" | "reject", payload: MemoryAuditActionPayload): string {
  if (payload.conflict && typeof payload.conflict === "string") {
    return `Could not apply suggestion: ${payload.conflict}`;
  }
  if (action === "apply") {
    return payload.applied === false ? "Suggestion was not applied." : "Suggestion applied.";
  }
  return payload.rejected === false ? "Suggestion was not rejected." : "Suggestion rejected.";
}

function didAuditActionSucceed(
  action: "apply" | "reject",
  payload: MemoryAuditActionPayload,
): boolean {
  if (payload.conflict) {
    return false;
  }
  return action === "apply" ? payload.applied !== false : payload.rejected !== false;
}

export async function runMemoryAuditAction(
  state: MemoryAuditState,
  suggestion: MemoryAuditSuggestion,
  action: "apply" | "reject",
): Promise<void> {
  if (!state.client || !state.connected || state.memoryAuditActionId || state.memoryAuditLoading) {
    return;
  }
  if (suggestion.status !== "pending") {
    return;
  }
  const method = action === "apply" ? "doctor.memory.auditApply" : "doctor.memory.auditReject";
  if (hasGatewayMethod(state, method) === false) {
    state.memoryAuditActionMessage = {
      kind: "error",
      text: methodUnavailableMessage(method),
    };
    return;
  }
  state.memoryAuditActionId = suggestion.id;
  state.memoryAuditActionMessage = null;
  state.memoryAuditError = null;
  try {
    const payload = await state.client.request<MemoryAuditActionPayload>(method, {
      id: suggestion.id,
      workspaceDir: suggestion.target.workspaceDir,
    });
    state.memoryAuditActionMessage = {
      kind: didAuditActionSucceed(action, payload ?? {}) ? "success" : "error",
      text: buildActionMessage(action, payload ?? {}),
    };
    await loadMemoryAuditSuggestions(state);
  } catch (err) {
    state.memoryAuditActionMessage = {
      kind: "error",
      text: String(err),
    };
  } finally {
    state.memoryAuditActionId = null;
  }
}
