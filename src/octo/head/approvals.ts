// Octopus Orchestrator — ApprovalService (M5-03)
//
// In-memory approval routing for the octo.approval.* flow. Operators
// with `octo.writer` capability can request, approve, or reject
// destructive control-plane actions.
//
// IMPORTANT (OCTO-DEC-029): This flow uses `octo.writer` device-token
// capability as the authorization gate. It does NOT use `tools.elevated`,
// which is specifically about sandbox breakout for `exec` and is owned
// by OpenClaw. See DECISIONS.md OCTO-DEC-029 for rationale.
//
// Context docs:
//   - INTEGRATION.md §Operator authorization model
//   - DECISIONS.md OCTO-DEC-029 — tools.elevated is NOT the gate
//   - DECISIONS.md OCTO-DEC-033 — boundary discipline
//
// Boundary discipline (OCTO-DEC-033):
//   Only relative imports inside `src/octo/` are permitted here.

import type { EventLogService } from "./event-log.ts";

// ──────────────────────────────────────────────────────────────────────────
// ApprovalRequest
// ──────────────────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  id: string;
  action: string;
  armId?: string;
  missionId?: string;
  requesterId: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  resolvedBy?: string;
  resolvedAt?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// ID generation — simple monotonic counter for in-memory use
// ──────────────────────────────────────────────────────────────────────────

let nextId = 1;

function generateApprovalId(): string {
  return `apr_${String(nextId++).padStart(6, "0")}`;
}

/** Reset the counter (test-only). */
export function resetApprovalIdCounter(): void {
  nextId = 1;
}

// ──────────────────────────────────────────────────────────────────────────
// ApprovalService
// ──────────────────────────────────────────────────────────────────────────

export class ApprovalService {
  private readonly requests: Map<string, ApprovalRequest> = new Map();

  constructor(private readonly eventLog: EventLogService) {}

  /**
   * Create a new pending approval request.
   */
  async request(
    action: string,
    context: { armId?: string; missionId?: string },
    requesterId: string,
  ): Promise<ApprovalRequest> {
    const req: ApprovalRequest = {
      id: generateApprovalId(),
      action,
      ...(context.armId != null ? { armId: context.armId } : {}),
      ...(context.missionId != null ? { missionId: context.missionId } : {}),
      requesterId,
      status: "pending",
      createdAt: Date.now(),
    };
    this.requests.set(req.id, req);
    return req;
  }

  /**
   * Approve a pending request. Emits `operator.approved` to the event log.
   * Throws if the request does not exist or is already resolved.
   */
  async approve(requestId: string, operatorId: string): Promise<ApprovalRequest> {
    const req = this.getRequestOrThrow(requestId);
    this.assertPending(req);

    req.status = "approved";
    req.resolvedBy = operatorId;
    req.resolvedAt = Date.now();

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "operator",
      entity_id: operatorId,
      event_type: "operator.approved",
      actor: operatorId,
      payload: {
        requestId: req.id,
        action: req.action,
        requesterId: req.requesterId,
        ...(req.armId != null ? { armId: req.armId } : {}),
        ...(req.missionId != null ? { missionId: req.missionId } : {}),
      },
    });

    return req;
  }

  /**
   * Reject a pending request. Emits `operator.rejected` to the event log.
   * Throws if the request does not exist or is already resolved.
   */
  async reject(requestId: string, operatorId: string, reason: string): Promise<ApprovalRequest> {
    const req = this.getRequestOrThrow(requestId);
    this.assertPending(req);

    req.status = "rejected";
    req.resolvedBy = operatorId;
    req.resolvedAt = Date.now();

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "operator",
      entity_id: operatorId,
      event_type: "operator.rejected",
      actor: operatorId,
      payload: {
        requestId: req.id,
        action: req.action,
        requesterId: req.requesterId,
        reason,
        ...(req.armId != null ? { armId: req.armId } : {}),
        ...(req.missionId != null ? { missionId: req.missionId } : {}),
      },
    });

    return req;
  }

  /**
   * Retrieve a single request by ID, or null if not found.
   */
  getRequest(requestId: string): ApprovalRequest | null {
    return this.requests.get(requestId) ?? null;
  }

  /**
   * List all requests that are still pending.
   */
  listPending(): ApprovalRequest[] {
    const pending: ApprovalRequest[] = [];
    for (const req of this.requests.values()) {
      if (req.status === "pending") {
        pending.push(req);
      }
    }
    return pending;
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private getRequestOrThrow(requestId: string): ApprovalRequest {
    const req = this.requests.get(requestId);
    if (req == null) {
      throw new Error(`ApprovalService: unknown request "${requestId}"`);
    }
    return req;
  }

  private assertPending(req: ApprovalRequest): void {
    if (req.status !== "pending") {
      throw new Error(`ApprovalService: request "${req.id}" is already ${req.status}`);
    }
  }
}
