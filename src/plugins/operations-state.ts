import type { OpenClawConfig } from "../config/config.js";

export type PluginOperationRecord = {
  operationId: string;
  namespace: string;
  kind: string;
  status: string;
  sourceId?: string;
  requesterSessionKey?: string;
  childSessionKey?: string;
  parentOperationId?: string;
  agentId?: string;
  runId?: string;
  title?: string;
  description: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  metadata?: Record<string, unknown>;
};

export type PluginOperationListQuery = {
  namespace?: string;
  kind?: string;
  status?: string;
  sessionKey?: string;
  runId?: string;
  sourceId?: string;
  parentOperationId?: string;
  limit?: number;
};

export type PluginOperationSummary = {
  total: number;
  active: number;
  terminal: number;
  failures: number;
  byNamespace: Record<string, number>;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
};

export type PluginOperationCreateEvent = {
  type: "create";
  namespace: string;
  kind: string;
  status?: string;
  sourceId?: string;
  requesterSessionKey?: string;
  childSessionKey?: string;
  parentOperationId?: string;
  agentId?: string;
  runId?: string;
  title?: string;
  description: string;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  metadata?: Record<string, unknown>;
};

export type PluginOperationTransitionEvent = {
  type: "transition";
  operationId?: string;
  runId?: string;
  status: string;
  at?: number;
  startedAt?: number;
  endedAt?: number;
  error?: string | null;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  metadataPatch?: Record<string, unknown>;
};

export type PluginOperationPatchEvent = {
  type: "patch";
  operationId?: string;
  runId?: string;
  at?: number;
  title?: string | null;
  description?: string | null;
  error?: string | null;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  metadataPatch?: Record<string, unknown>;
};

export type PluginOperationDispatchEvent =
  | PluginOperationCreateEvent
  | PluginOperationTransitionEvent
  | PluginOperationPatchEvent;

export type PluginOperationDispatchResult = {
  matched: boolean;
  created?: boolean;
  record: PluginOperationRecord | null;
};

export type PluginOperationsCancelResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  record?: PluginOperationRecord | null;
};

export type PluginOperationAuditSeverity = "warn" | "error";

export type PluginOperationAuditFinding = {
  severity: PluginOperationAuditSeverity;
  code: string;
  operation: PluginOperationRecord;
  detail: string;
  ageMs?: number;
};

export type PluginOperationAuditSummary = {
  total: number;
  warnings: number;
  errors: number;
  byCode: Record<string, number>;
};

export type PluginOperationAuditQuery = {
  namespace?: string;
  severity?: PluginOperationAuditSeverity;
  code?: string;
};

export type PluginOperationMaintenanceQuery = {
  namespace?: string;
  apply?: boolean;
};

export type PluginOperationMaintenanceSummary = {
  reconciled: number;
  cleanupStamped: number;
  pruned: number;
};

export type PluginOperationsRuntime = {
  dispatch(event: PluginOperationDispatchEvent): Promise<PluginOperationDispatchResult>;
  getById(operationId: string): Promise<PluginOperationRecord | null>;
  findByRunId(runId: string): Promise<PluginOperationRecord | null>;
  list(query?: PluginOperationListQuery): Promise<PluginOperationRecord[]>;
  summarize(query?: PluginOperationListQuery): Promise<PluginOperationSummary>;
  audit(query?: PluginOperationAuditQuery): Promise<PluginOperationAuditFinding[]>;
  maintenance(query?: PluginOperationMaintenanceQuery): Promise<PluginOperationMaintenanceSummary>;
  cancel(params: {
    cfg: OpenClawConfig;
    operationId: string;
  }): Promise<PluginOperationsCancelResult>;
};

type OperationsRuntimeState = {
  runtime?: PluginOperationsRuntime;
  ownerPluginId?: string;
};

type RegisterOperationsRuntimeResult = { ok: true } | { ok: false; existingOwner?: string };

const operationsRuntimeState: OperationsRuntimeState = {};

function normalizeOwnedPluginId(ownerPluginId: string): string {
  return ownerPluginId.trim();
}

export function registerOperationsRuntimeForOwner(
  runtime: PluginOperationsRuntime,
  ownerPluginId: string,
  opts?: { allowSameOwnerRefresh?: boolean },
): RegisterOperationsRuntimeResult {
  const nextOwner = normalizeOwnedPluginId(ownerPluginId);
  const existingOwner = operationsRuntimeState.ownerPluginId?.trim();
  if (
    operationsRuntimeState.runtime &&
    existingOwner &&
    existingOwner !== nextOwner &&
    !(opts?.allowSameOwnerRefresh === true && existingOwner === nextOwner)
  ) {
    return {
      ok: false,
      existingOwner,
    };
  }
  operationsRuntimeState.runtime = runtime;
  operationsRuntimeState.ownerPluginId = nextOwner;
  return { ok: true };
}

export function getRegisteredOperationsRuntime(): PluginOperationsRuntime | undefined {
  return operationsRuntimeState.runtime;
}

export function getRegisteredOperationsRuntimeOwner(): string | undefined {
  return operationsRuntimeState.ownerPluginId;
}

export function hasRegisteredOperationsRuntime(): boolean {
  return operationsRuntimeState.runtime !== undefined;
}

export function restoreOperationsRuntimeState(state: OperationsRuntimeState): void {
  operationsRuntimeState.runtime = state.runtime;
  operationsRuntimeState.ownerPluginId = state.ownerPluginId?.trim() || undefined;
}

export function clearOperationsRuntimeState(): void {
  operationsRuntimeState.runtime = undefined;
  operationsRuntimeState.ownerPluginId = undefined;
}

export function isActiveOperationStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

export function isFailureOperationStatus(status: string): boolean {
  return status === "failed" || status === "timed_out" || status === "lost";
}

export function summarizeOperationRecords(
  records: Iterable<PluginOperationRecord>,
): PluginOperationSummary {
  const summary: PluginOperationSummary = {
    total: 0,
    active: 0,
    terminal: 0,
    failures: 0,
    byNamespace: {},
    byKind: {},
    byStatus: {},
  };
  for (const record of records) {
    summary.total += 1;
    summary.byNamespace[record.namespace] = (summary.byNamespace[record.namespace] ?? 0) + 1;
    summary.byKind[record.kind] = (summary.byKind[record.kind] ?? 0) + 1;
    summary.byStatus[record.status] = (summary.byStatus[record.status] ?? 0) + 1;
    if (isActiveOperationStatus(record.status)) {
      summary.active += 1;
    } else {
      summary.terminal += 1;
    }
    if (isFailureOperationStatus(record.status)) {
      summary.failures += 1;
    }
  }
  return summary;
}

export function summarizeOperationAuditFindings(
  findings: Iterable<PluginOperationAuditFinding>,
): PluginOperationAuditSummary {
  const summary: PluginOperationAuditSummary = {
    total: 0,
    warnings: 0,
    errors: 0,
    byCode: {},
  };
  for (const finding of findings) {
    summary.total += 1;
    summary.byCode[finding.code] = (summary.byCode[finding.code] ?? 0) + 1;
    if (finding.severity === "error") {
      summary.errors += 1;
      continue;
    }
    summary.warnings += 1;
  }
  return summary;
}
