import { randomUUID } from "node:crypto";

// Keep resolved entries briefly so waiters racing with resolve can still observe the decision.
const RESOLVED_ENTRY_GRACE_MS = 15_000;

export type KnowledgeTransferApprovalDecision = "allow" | "deny";
export type KnowledgeTransferApprovalKind = "export" | "import";

export type KnowledgeTransferApprovalRequestPayload = {
  approvalKind: KnowledgeTransferApprovalKind;
  requesterAgentId: string;
  targetAgentId: string;
  requesterSessionKey: string;
  targetSessionKey: string;
  requestedBySessionKey?: string | null;
  requestedByChannel?: string | null;
  mode: "ask";
  itemCount: number;
  itemFingerprints: string[];
  summary: string[];
};

export type KnowledgeTransferApprovalRecord = {
  id: string;
  request: KnowledgeTransferApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
  requestedByConnId?: string | null;
  requestedByDeviceId?: string | null;
  requestedByClientId?: string | null;
  resolvedAtMs?: number;
  decision?: KnowledgeTransferApprovalDecision;
  resolvedBy?: string | null;
};

type PendingEntry = {
  record: KnowledgeTransferApprovalRecord;
  resolve: (decision: KnowledgeTransferApprovalDecision | null) => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<KnowledgeTransferApprovalDecision | null>;
};

export class KnowledgeTransferApprovalManager {
  private pending = new Map<string, PendingEntry>();

  create(
    request: KnowledgeTransferApprovalRequestPayload,
    timeoutMs: number,
    id?: string | null,
  ): KnowledgeTransferApprovalRecord {
    const now = Date.now();
    const resolvedId = id && id.trim().length > 0 ? id.trim() : randomUUID();
    return {
      id: resolvedId,
      request,
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    };
  }

  register(
    record: KnowledgeTransferApprovalRecord,
    timeoutMs: number,
  ): Promise<KnowledgeTransferApprovalDecision | null> {
    const existing = this.pending.get(record.id);
    if (existing) {
      if (existing.record.resolvedAtMs === undefined) {
        return existing.promise;
      }
      throw new Error(`approval id '${record.id}' already resolved`);
    }

    let resolvePromise!: (decision: KnowledgeTransferApprovalDecision | null) => void;
    const promise = new Promise<KnowledgeTransferApprovalDecision | null>((resolve) => {
      resolvePromise = resolve;
    });

    const entry: PendingEntry = {
      record,
      resolve: resolvePromise,
      timer: null as unknown as ReturnType<typeof setTimeout>,
      promise,
    };
    entry.timer = setTimeout(() => {
      this.expire(record.id);
    }, timeoutMs);
    this.pending.set(record.id, entry);
    return promise;
  }

  awaitDecision(recordId: string): Promise<KnowledgeTransferApprovalDecision | null> | null {
    return this.pending.get(recordId)?.promise ?? null;
  }

  getSnapshot(recordId: string): KnowledgeTransferApprovalRecord | null {
    return this.pending.get(recordId)?.record ?? null;
  }

  listPending(): KnowledgeTransferApprovalRecord[] {
    const now = Date.now();
    const records: KnowledgeTransferApprovalRecord[] = [];
    for (const entry of this.pending.values()) {
      if (entry.record.expiresAtMs < now && entry.record.resolvedAtMs == null) {
        continue;
      }
      records.push(entry.record);
    }
    records.sort((a, b) => b.createdAtMs - a.createdAtMs);
    return records;
  }

  resolve(
    recordId: string,
    decision: KnowledgeTransferApprovalDecision,
    resolvedBy?: string | null,
  ): boolean {
    const pending = this.pending.get(recordId);
    if (!pending) {
      return false;
    }
    if (pending.record.resolvedAtMs !== undefined) {
      return false;
    }
    clearTimeout(pending.timer);
    pending.record.resolvedAtMs = Date.now();
    pending.record.decision = decision;
    pending.record.resolvedBy = resolvedBy ?? null;
    pending.resolve(decision);
    setTimeout(() => {
      if (this.pending.get(recordId) === pending) {
        this.pending.delete(recordId);
      }
    }, RESOLVED_ENTRY_GRACE_MS);
    return true;
  }

  expire(recordId: string, resolvedBy?: string | null): boolean {
    const pending = this.pending.get(recordId);
    if (!pending) {
      return false;
    }
    if (pending.record.resolvedAtMs !== undefined) {
      return false;
    }
    clearTimeout(pending.timer);
    pending.record.resolvedAtMs = Date.now();
    pending.record.decision = undefined;
    pending.record.resolvedBy = resolvedBy ?? null;
    pending.resolve(null);
    setTimeout(() => {
      if (this.pending.get(recordId) === pending) {
        this.pending.delete(recordId);
      }
    }, RESOLVED_ENTRY_GRACE_MS);
    return true;
  }
}
