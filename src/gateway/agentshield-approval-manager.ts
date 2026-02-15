import { createHash, randomUUID } from "node:crypto";

// ── Shared types (authoritative source — other modules import from here) ──

export type AgentShieldApprovalDecision = "allow-once" | "allow-always" | "deny";

export type AgentShieldApprovalRequestPayload = {
  toolName: string;
  /** Canonical JSON of the tool params — never logged, only hashed. */
  paramsJSON: string;
  agentId?: string | null;
  sessionKey?: string | null;
};

export type AgentShieldApprovalRecord = {
  id: string;
  toolName: string;
  /** SHA-256 of the canonical JSON params (never raw args). */
  argsFingerprint: string;
  agentId: string;
  sessionKey: string;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs?: number;
  decision?: AgentShieldApprovalDecision;
  resolvedBy?: string | null;
};

type PendingEntry = {
  record: AgentShieldApprovalRecord;
  resolve: (decision: AgentShieldApprovalDecision | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** SHA-256 hex digest of canonical JSON params. */
export function computeArgsFingerprint(paramsJSON: string): string {
  return createHash("sha256").update(paramsJSON).digest("hex");
}

export class AgentShieldApprovalManager {
  private pending = new Map<string, PendingEntry>();

  create(
    request: AgentShieldApprovalRequestPayload,
    timeoutMs: number,
    id?: string | null,
  ): AgentShieldApprovalRecord {
    const now = Date.now();
    const resolvedId = id && id.trim().length > 0 ? id.trim() : randomUUID();
    const record: AgentShieldApprovalRecord = {
      id: resolvedId,
      toolName: request.toolName,
      argsFingerprint: computeArgsFingerprint(request.paramsJSON),
      agentId: request.agentId ?? "",
      sessionKey: request.sessionKey ?? "",
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    };
    return record;
  }

  async waitForDecision(
    record: AgentShieldApprovalRecord,
    timeoutMs: number,
  ): Promise<AgentShieldApprovalDecision | null> {
    return await new Promise<AgentShieldApprovalDecision | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(record.id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(record.id, { record, resolve, reject, timer });
    });
  }

  resolve(
    recordId: string,
    decision: AgentShieldApprovalDecision,
    resolvedBy?: string | null,
  ): boolean {
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

  getSnapshot(recordId: string): AgentShieldApprovalRecord | null {
    const entry = this.pending.get(recordId);
    return entry?.record ?? null;
  }

  listPending(): AgentShieldApprovalRecord[] {
    return Array.from(this.pending.values()).map((e) => e.record);
  }
}
