import { createAuditEvent } from "../../extensions/govdoss-core/src/audit";
import { govdossApprovalStore } from "./approval-store.js";

export type GovdossResumeResult =
  | { status: "not-found"; approvalId: string }
  | { status: "not-approved"; approvalId: string; currentStatus: string }
  | { status: "ready"; approvalId: string; method: string; subject: string };

export function approveGovdossRequest(approvalId: string): GovdossResumeResult {
  const record = govdossApprovalStore.approve(approvalId);
  if (!record) {
    return { status: "not-found", approvalId };
  }
  return {
    status: "ready",
    approvalId,
    method: record.method,
    subject: record.subject,
  };
}

export function rejectGovdossRequest(approvalId: string): GovdossResumeResult {
  const record = govdossApprovalStore.reject(approvalId);
  if (!record) {
    return { status: "not-found", approvalId };
  }
  return {
    status: "not-approved",
    approvalId,
    currentStatus: record.status,
  };
}

export function resumeGovdossRequest(approvalId: string): GovdossResumeResult {
  const record = govdossApprovalStore.get(approvalId);
  if (!record) {
    return { status: "not-found", approvalId };
  }
  if (record.status !== "approved") {
    return {
      status: "not-approved",
      approvalId,
      currentStatus: record.status,
    };
  }
  govdossApprovalStore.consume(approvalId);
  const event = createAuditEvent({
    subject: record.subject,
    object: record.method,
    authentication: "gateway-session",
    authorization: "approved",
    approval: "used",
    action: "govdoss.resume",
    outcome: approvalId,
    metadata: {
      risk: record.risk,
      decision: record.decision,
      continuation: record.continuation,
    },
  });
  return {
    status: "ready",
    approvalId,
    method: record.method,
    subject: `${record.subject}#${event.timestamp}`,
  };
}
