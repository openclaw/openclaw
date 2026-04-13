import crypto from "node:crypto";
import { summarizePlanRecords } from "./plan-registry.summary.js";
import type {
  PlanRecord,
  PlanRecordFormat,
  PlanRecordStatus,
  PlanRegistrySummary,
  PlanScopeKind,
  PlanStatusUpdateResult,
  UpdatePlanStatusParams,
} from "./plan-registry.types.js";
import { PlanStatusTransitionError, assertPlanStatusTransition } from "./plan-registry.types.js";

const plans = new Map<string, PlanRecord>();
const planIdsByOwnerKey = new Map<string, Set<string>>();
const planIdsBySessionKey = new Map<string, Set<string>>();
const planIdsByParentPlanId = new Map<string, Set<string>>();

function clonePlanRecord(record: PlanRecord): PlanRecord {
  return {
    ...record,
    ...(record.linkedFlowIds ? { linkedFlowIds: [...record.linkedFlowIds] } : {}),
  };
}

function upsertIndex(index: Map<string, Set<string>>, key: string | undefined, planId: string) {
  const normalizedKey = key?.trim();
  if (!normalizedKey) {
    return;
  }
  const existing = index.get(normalizedKey) ?? new Set<string>();
  existing.add(planId);
  index.set(normalizedKey, existing);
}

function removeFromIndex(index: Map<string, Set<string>>, key: string | undefined, planId: string) {
  const normalizedKey = key?.trim();
  if (!normalizedKey) {
    return;
  }
  const existing = index.get(normalizedKey);
  if (!existing) {
    return;
  }
  existing.delete(planId);
  if (existing.size === 0) {
    index.delete(normalizedKey);
  }
}

function indexPlan(record: PlanRecord) {
  upsertIndex(planIdsByOwnerKey, record.ownerKey, record.planId);
  upsertIndex(planIdsBySessionKey, record.sessionKey, record.planId);
  upsertIndex(planIdsByParentPlanId, record.parentPlanId, record.planId);
}

function deindexPlan(record: PlanRecord) {
  removeFromIndex(planIdsByOwnerKey, record.ownerKey, record.planId);
  removeFromIndex(planIdsBySessionKey, record.sessionKey, record.planId);
  removeFromIndex(planIdsByParentPlanId, record.parentPlanId, record.planId);
}

function createPlanId(): string {
  return `plan_${crypto.randomUUID()}`;
}

export function createPlanRecord(params: {
  ownerKey: string;
  scopeKind: PlanScopeKind;
  title: string;
  content: string;
  summary?: string;
  format?: PlanRecordFormat;
  sessionKey?: string;
  parentPlanId?: string;
  linkedFlowIds?: string[];
  status?: PlanRecordStatus;
  createdAt?: number;
  updatedAt?: number;
}): PlanRecord {
  const now = params.updatedAt ?? params.createdAt ?? Date.now();
  const record: PlanRecord = {
    planId: createPlanId(),
    ownerKey: params.ownerKey.trim(),
    scopeKind: params.scopeKind,
    ...(params.sessionKey?.trim() ? { sessionKey: params.sessionKey.trim() } : {}),
    ...(params.parentPlanId?.trim() ? { parentPlanId: params.parentPlanId.trim() } : {}),
    title: params.title.trim(),
    ...(params.summary?.trim() ? { summary: params.summary.trim() } : {}),
    content: params.content,
    format: params.format ?? "markdown",
    status: params.status ?? "draft",
    ...(params.linkedFlowIds?.length
      ? { linkedFlowIds: [...new Set(params.linkedFlowIds.map((id) => id.trim()).filter(Boolean))] }
      : {}),
    createdAt: params.createdAt ?? now,
    updatedAt: now,
  };
  plans.set(record.planId, record);
  indexPlan(record);
  return clonePlanRecord(record);
}

export function listPlanRecords(): PlanRecord[] {
  return [...plans.values()]
    .map((record) => clonePlanRecord(record))
    .toSorted(
      (left, right) => right.updatedAt - left.updatedAt || left.planId.localeCompare(right.planId),
    );
}

export function getPlanById(planId: string): PlanRecord | undefined {
  const existing = plans.get(planId);
  return existing ? clonePlanRecord(existing) : undefined;
}

function listPlansByIndex(index: Map<string, Set<string>>, key: string): PlanRecord[] {
  const ids = index.get(key.trim());
  if (!ids) {
    return [];
  }
  return [...ids]
    .map((planId) => plans.get(planId))
    .filter((record): record is PlanRecord => Boolean(record))
    .map((record) => clonePlanRecord(record))
    .toSorted(
      (left, right) => right.updatedAt - left.updatedAt || left.planId.localeCompare(right.planId),
    );
}

export function listPlansForOwnerKey(ownerKey: string): PlanRecord[] {
  return listPlansByIndex(planIdsByOwnerKey, ownerKey);
}

export function listPlansForSessionKey(sessionKey: string): PlanRecord[] {
  return listPlansByIndex(planIdsBySessionKey, sessionKey);
}

export function listChildPlans(parentPlanId: string): PlanRecord[] {
  return listPlansByIndex(planIdsByParentPlanId, parentPlanId);
}

export function updatePlanRecordById(
  planId: string,
  updates: Partial<
    Pick<
      PlanRecord,
      | "title"
      | "summary"
      | "content"
      | "format"
      | "status"
      | "sessionKey"
      | "parentPlanId"
      | "linkedFlowIds"
    >
  > & {
    updatedAt?: number;
  },
): PlanRecord | undefined {
  const existing = plans.get(planId);
  if (!existing) {
    return undefined;
  }
  const nextStatus = updates.status ?? existing.status;
  const updatedAt = updates.updatedAt ?? Date.now();
  const next: PlanRecord = {
    ...existing,
    ...(updates.title !== undefined ? { title: updates.title.trim() } : {}),
    ...(updates.summary !== undefined
      ? updates.summary.trim()
        ? { summary: updates.summary.trim() }
        : { summary: undefined }
      : {}),
    ...(updates.content !== undefined ? { content: updates.content } : {}),
    ...(updates.format !== undefined ? { format: updates.format } : {}),
    ...(updates.sessionKey !== undefined
      ? updates.sessionKey.trim()
        ? { sessionKey: updates.sessionKey.trim() }
        : { sessionKey: undefined }
      : {}),
    ...(updates.parentPlanId !== undefined
      ? updates.parentPlanId.trim()
        ? { parentPlanId: updates.parentPlanId.trim() }
        : { parentPlanId: undefined }
      : {}),
    ...(updates.linkedFlowIds !== undefined
      ? updates.linkedFlowIds.length
        ? {
            linkedFlowIds: [
              ...new Set(updates.linkedFlowIds.map((id) => id.trim()).filter(Boolean)),
            ],
          }
        : { linkedFlowIds: undefined }
      : {}),
    status: nextStatus,
    updatedAt,
    reviewedAt:
      nextStatus === "ready_for_review" || nextStatus === "approved" || nextStatus === "rejected"
        ? (existing.reviewedAt ?? updatedAt)
        : existing.reviewedAt,
    approvedAt:
      nextStatus === "approved" ? (existing.approvedAt ?? updatedAt) : existing.approvedAt,
    rejectedAt:
      nextStatus === "rejected" ? (existing.rejectedAt ?? updatedAt) : existing.rejectedAt,
    archivedAt:
      nextStatus === "archived" ? (existing.archivedAt ?? updatedAt) : existing.archivedAt,
  };
  deindexPlan(existing);
  plans.set(planId, next);
  indexPlan(next);
  return clonePlanRecord(next);
}

export function updatePlanStatus(params: UpdatePlanStatusParams): PlanStatusUpdateResult {
  const existing = plans.get(params.planId);
  if (!existing) {
    throw new PlanStatusTransitionError("plan_not_found", `plan not found: ${params.planId}`, {
      planId: params.planId,
      to: params.status,
    });
  }
  assertPlanStatusTransition({
    planId: params.planId,
    from: existing.status,
    to: params.status,
  });
  const updated = updatePlanRecordById(params.planId, {
    status: params.status,
    updatedAt: params.updatedAt,
  });
  if (!updated) {
    throw new PlanStatusTransitionError("plan_not_found", `plan not found: ${params.planId}`, {
      planId: params.planId,
      to: params.status,
    });
  }
  return {
    plan: updated,
    previousStatus: existing.status,
  };
}

export function getPlanRegistrySummary(): PlanRegistrySummary {
  return summarizePlanRecords(plans.values());
}

export function resetPlanRegistryForTests(): void {
  plans.clear();
  planIdsByOwnerKey.clear();
  planIdsBySessionKey.clear();
  planIdsByParentPlanId.clear();
}
