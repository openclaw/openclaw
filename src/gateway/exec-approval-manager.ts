import { randomUUID } from "node:crypto";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";

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

export type ExecApprovalRecord = {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs?: number;
  decision?: ExecApprovalDecision;
  resolvedBy?: string | null;
};

type PendingEntry = {
  record: ExecApprovalRecord;
  resolve: (decision: ExecApprovalDecision | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ExecApprovalManager {
  private pending = new Map<string, PendingEntry>();

  create(
    request: ExecApprovalRequestPayload,
    timeoutMs: number,
    id?: string | null,
  ): ExecApprovalRecord {
    const now = Date.now();
    const resolvedId = id && id.trim().length > 0 ? id.trim() : randomUUID();
    const record: ExecApprovalRecord = {
      id: resolvedId,
      request,
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    };
    return record;
  }

  async waitForDecision(
    record: ExecApprovalRecord,
    timeoutMs: number,
  ): Promise<ExecApprovalDecision | null> {
    return await new Promise<ExecApprovalDecision | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(record.id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(record.id, { record, resolve, reject, timer });
    });
  }

  resolve(recordId: string, decision: ExecApprovalDecision, resolvedBy?: string | null): boolean {
    const pending = this.pending.get(recordId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    pending.record.resolvedAtMs = Date.now();
    pending.record.decision = decision;
    pending.record.resolvedBy = resolvedBy ?? null;
    this.pending.delete(recordId);
    pending.resolve(decision);
    return true;
  }

  getSnapshot(recordId: string): ExecApprovalRecord | null {
    const entry = this.pending.get(recordId);
    return entry?.record ?? null;
  }
}
