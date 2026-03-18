import type { GatewayGuardResult } from "./gateway-guard.js";

type PendingApprovalRecord = {
  approvalId: string;
  method: string;
  subject: string;
  risk: string;
  createdAt: number;
  continuation: GatewayGuardResult extends infer T
    ? T extends { status: "approval-required"; continuation: infer C }
      ? C
      : never
    : never;
  decision: GatewayGuardResult extends infer T
    ? T extends { status: "approval-required"; decision: infer D }
      ? D
      : never
    : never;
  status: "pending" | "approved" | "rejected" | "consumed";
};

export class GovdossApprovalStore {
  private readonly records = new Map<string, PendingApprovalRecord>();

  save(record: PendingApprovalRecord): PendingApprovalRecord {
    this.records.set(record.approvalId, record);
    return record;
  }

  get(approvalId: string): PendingApprovalRecord | null {
    return this.records.get(approvalId) ?? null;
  }

  approve(approvalId: string): PendingApprovalRecord | null {
    const record = this.records.get(approvalId);
    if (!record) return null;
    record.status = "approved";
    this.records.set(approvalId, record);
    return record;
  }

  reject(approvalId: string): PendingApprovalRecord | null {
    const record = this.records.get(approvalId);
    if (!record) return null;
    record.status = "rejected";
    this.records.set(approvalId, record);
    return record;
  }

  consume(approvalId: string): PendingApprovalRecord | null {
    const record = this.records.get(approvalId);
    if (!record) return null;
    record.status = "consumed";
    this.records.set(approvalId, record);
    return record;
  }

  list(): PendingApprovalRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}

export const govdossApprovalStore = new GovdossApprovalStore();
