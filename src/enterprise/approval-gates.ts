import type { ApprovalRequest } from "./types.js";

/**
 * Manages approval gates for human-in-the-loop workflows.
 */
export class ApprovalGates {
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private approvalCallbacks: Map<
    string,
    (request: ApprovalRequest) => Promise<void>
  > = new Map();

  /**
   * Creates an approval request.
   */
  async requestApproval(
    workflowExecutionId: string,
    stepId: string,
    gateId: string,
    message: string,
    timeoutMs: number = 3600000, // 1 hour default
  ): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: `approval_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      workflowExecutionId,
      stepId,
      gateId,
      message,
      requestedAt: new Date(),
      status: "pending",
    };

    this.pendingApprovals.set(request.id, request);

    // Set timeout
    if (timeoutMs > 0) {
      setTimeout(() => {
        const req = this.pendingApprovals.get(request.id);
        if (req && req.status === "pending") {
          req.status = "expired";
          this.pendingApprovals.set(request.id, req);
        }
      }, timeoutMs);
    }

    // Notify callback if registered
    const callback = this.approvalCallbacks.get(gateId);
    if (callback) {
      await callback(request);
    }

    return request;
  }

  /**
   * Approves a pending request.
   */
  approve(requestId: string, approvedBy: string): boolean {
    const request = this.pendingApprovals.get(requestId);
    if (!request || request.status !== "pending") {
      return false;
    }

    request.status = "approved";
    request.approvedAt = new Date();
    request.approvedBy = approvedBy;
    this.pendingApprovals.set(requestId, request);

    return true;
  }

  /**
   * Rejects a pending request.
   */
  reject(requestId: string, rejectedBy: string, reason?: string): boolean {
    const request = this.pendingApprovals.get(requestId);
    if (!request || request.status !== "pending") {
      return false;
    }

    request.status = "rejected";
    request.rejectedAt = new Date();
    request.rejectedBy = rejectedBy;
    if (reason) {
      request.message += `\n\nRejection reason: ${reason}`;
    }
    this.pendingApprovals.set(requestId, request);

    return true;
  }

  /**
   * Gets a pending approval request.
   */
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.pendingApprovals.get(requestId);
  }

  /**
   * Gets all pending approvals.
   */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values()).filter(
      (r) => r.status === "pending",
    );
  }

  /**
   * Registers a callback for approval notifications.
   */
  onApprovalRequest(
    gateId: string,
    callback: (request: ApprovalRequest) => Promise<void>,
  ): void {
    this.approvalCallbacks.set(gateId, callback);
  }
}
