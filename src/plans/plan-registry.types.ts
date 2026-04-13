export type PlanRecordFormat = "markdown" | "text" | "json";

export type PlanRecordStatus = "draft" | "ready_for_review" | "approved" | "rejected" | "archived";

export type PlanScopeKind = "session" | "agent" | "system";

export type PlanStatusCounts = Record<PlanRecordStatus, number>;

export type PlanRegistrySummary = {
  total: number;
  reviewable: number;
  terminal: number;
  byStatus: PlanStatusCounts;
};

export type PlanRecord = {
  planId: string;
  ownerKey: string;
  scopeKind: PlanScopeKind;
  sessionKey?: string;
  parentPlanId?: string;
  title: string;
  summary?: string;
  content: string;
  format: PlanRecordFormat;
  status: PlanRecordStatus;
  linkedFlowIds?: string[];
  createdAt: number;
  updatedAt: number;
  reviewedAt?: number;
  approvedAt?: number;
  rejectedAt?: number;
  archivedAt?: number;
};

export type PlanStatusTransitionErrorCode = "plan_not_found" | "invalid_transition" | "same_status";

export class PlanStatusTransitionError extends Error {
  constructor(
    public readonly code: PlanStatusTransitionErrorCode,
    message: string,
    public readonly details?: {
      planId?: string;
      from?: PlanRecordStatus;
      to?: PlanRecordStatus;
    },
  ) {
    super(message);
    this.name = "PlanStatusTransitionError";
  }
}

export function isPlanStatusTransitionError(error: unknown): error is PlanStatusTransitionError {
  return error instanceof PlanStatusTransitionError;
}

export type PlanStatusUpdateResult = {
  plan: PlanRecord;
  previousStatus: PlanRecordStatus;
};

export type PlanStatusTransitionMap = Record<PlanRecordStatus, readonly PlanRecordStatus[]>;

export const ALLOWED_PLAN_STATUS_TRANSITIONS: PlanStatusTransitionMap = {
  draft: ["ready_for_review"],
  ready_for_review: ["approved", "rejected"],
  approved: ["archived"],
  rejected: ["archived"],
  archived: [],
};

export function canTransitionPlanStatus(from: PlanRecordStatus, to: PlanRecordStatus): boolean {
  return ALLOWED_PLAN_STATUS_TRANSITIONS[from].includes(to);
}

export function listAllowedPlanStatusTransitions(
  from: PlanRecordStatus,
): readonly PlanRecordStatus[] {
  return ALLOWED_PLAN_STATUS_TRANSITIONS[from];
}

export function assertPlanStatusTransition(params: {
  planId: string;
  from: PlanRecordStatus;
  to: PlanRecordStatus;
}): void {
  if (params.from === params.to) {
    throw new PlanStatusTransitionError(
      "same_status",
      `plan ${params.planId} is already ${params.to}`,
      { planId: params.planId, from: params.from, to: params.to },
    );
  }
  if (!canTransitionPlanStatus(params.from, params.to)) {
    throw new PlanStatusTransitionError(
      "invalid_transition",
      `invalid plan status transition ${params.from} -> ${params.to}`,
      { planId: params.planId, from: params.from, to: params.to },
    );
  }
}

export type UpdatePlanStatusParams = {
  planId: string;
  status: PlanRecordStatus;
  updatedAt?: number;
};

export type PlansUpdateStatusResult = {
  plan: PlanRecord;
  previousStatus: PlanRecordStatus;
};

export type PlansUpdateStatusParams = UpdatePlanStatusParams;
