import { randomUUID } from "node:crypto";

export type HitlApprovalDecision = "allow-once" | "allow-always" | "deny";

export type HitlApprovalKind = "outbound" | "plugin-http";

export type HitlApprovalRecord = {
  /** Local OpenClaw approval id. */
  id: string;
  kind: HitlApprovalKind;
  /**
   * HITL.sh request id (populated after request creation succeeds).
   * Used to resolve decisions via webhook callbacks.
   */
  hitlRequestId?: string;
  createdAtMs: number;
  expiresAtMs: number;
  /** Decision to apply if the request times out or is cancelled. */
  defaultDecision: HitlApprovalDecision;
  /** Minimal, non-secret data used for logs/diagnostics. */
  summary: Record<string, unknown>;
  resolvedAtMs?: number;
  decision?: HitlApprovalDecision;
  resolvedBy?: string | null;
};

type PendingEntry = {
  record: HitlApprovalRecord;
  resolve: (decision: HitlApprovalDecision | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * In-memory approval manager for HITL-backed gating.
 *
 * This mirrors the `ExecApprovalManager` pattern: create a record, wait for a
 * decision, resolve it later (typically via the gateway webhook callback).
 *
 * Records are intentionally minimal to avoid accidentally retaining secrets
 * from outbound messages or plugin routes.
 */
export class HitlApprovalManager {
  private pendingById = new Map<string, PendingEntry>();
  private pendingIdByHitlRequestId = new Map<string, string>();

  create(params: {
    kind: HitlApprovalKind;
    timeoutMs: number;
    summary: Record<string, unknown>;
    defaultDecision: HitlApprovalDecision;
    id?: string | null;
  }): HitlApprovalRecord {
    const now = Date.now();
    const resolvedId = params.id && params.id.trim().length > 0 ? params.id.trim() : randomUUID();
    return {
      id: resolvedId,
      kind: params.kind,
      createdAtMs: now,
      expiresAtMs: now + params.timeoutMs,
      defaultDecision: params.defaultDecision,
      summary: params.summary,
    };
  }

  /**
   * Associates a HITL.sh request id with a local approval record.
   * Returns false if the record is no longer pending (timeout/resolved).
   */
  attachHitlRequestId(recordId: string, hitlRequestId: string): boolean {
    const pending = this.pendingById.get(recordId);
    const normalized = hitlRequestId?.trim();
    if (!pending || !normalized) {
      return false;
    }
    pending.record.hitlRequestId = normalized;
    this.pendingIdByHitlRequestId.set(normalized, recordId);
    return true;
  }

  async waitForDecision(
    record: HitlApprovalRecord,
    timeoutMs: number,
  ): Promise<HitlApprovalDecision | null> {
    return await new Promise<HitlApprovalDecision | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingById.delete(record.id);
        if (record.hitlRequestId) {
          this.pendingIdByHitlRequestId.delete(record.hitlRequestId);
        }
        resolve(null);
      }, timeoutMs);
      this.pendingById.set(record.id, { record, resolve, timer });
    });
  }

  resolve(recordId: string, decision: HitlApprovalDecision, resolvedBy?: string | null): boolean {
    const pending = this.pendingById.get(recordId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    pending.record.resolvedAtMs = Date.now();
    pending.record.decision = decision;
    pending.record.resolvedBy = resolvedBy ?? null;
    this.pendingById.delete(recordId);
    if (pending.record.hitlRequestId) {
      this.pendingIdByHitlRequestId.delete(pending.record.hitlRequestId);
    }
    pending.resolve(decision);
    return true;
  }

  resolveByHitlRequestId(params: {
    hitlRequestId: string;
    decision: HitlApprovalDecision;
    resolvedBy?: string | null;
  }): boolean {
    const id = this.pendingIdByHitlRequestId.get(params.hitlRequestId);
    if (!id) {
      return false;
    }
    return this.resolve(id, params.decision, params.resolvedBy);
  }

  /**
   * Resolves by HITL request id, using the pending record's default decision.
   * Useful for `request.timeout` and `request.cancelled` webhooks.
   */
  resolveDefaultByHitlRequestId(params: {
    hitlRequestId: string;
    resolvedBy?: string | null;
  }): boolean {
    const id = this.pendingIdByHitlRequestId.get(params.hitlRequestId);
    if (!id) {
      return false;
    }
    const pending = this.pendingById.get(id);
    if (!pending) {
      return false;
    }
    return this.resolve(id, pending.record.defaultDecision, params.resolvedBy);
  }

  getSnapshot(recordId: string): HitlApprovalRecord | null {
    const entry = this.pendingById.get(recordId);
    return entry?.record ?? null;
  }
}
