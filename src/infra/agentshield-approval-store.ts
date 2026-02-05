import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

/**
 * Disk-based approval persistence for AgentShield approvals.
 *
 * Directory structure:
 *   <stateDir>/agentshield/approvals/
 *     requests/<id>.json   — approval request metadata (never raw args)
 *     decisions/<id>.json  — operator decisions
 *
 * Security:
 * - Never stores raw tool args; only safe metadata + argsFingerprint
 * - All files written with mode 0o600
 * - Directories created with mode 0o700
 */

export type ApprovalRequestStatus = "pending" | "approved" | "denied" | "expired";

export type ApprovalRequestRecord = {
  id: string;
  toolName: string;
  argsFingerprint: string;
  argsSummary?: string;
  agentId: string;
  sessionKey: string;
  createdAt: string;
  expiresAt: string;
  status: ApprovalRequestStatus;
};

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export type ApprovalDecisionRecord = {
  id: string;
  decision: ApprovalDecision;
  reason?: string;
  resolvedBy?: string;
  resolvedAt: string;
};

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function writeJsonSecure(filepath: string, data: unknown): void {
  const dir = path.dirname(filepath);
  ensureDir(dir);
  const content = JSON.stringify(data, Object.keys(data as object).sort(), 2) + "\n";
  fs.writeFileSync(filepath, content, { mode: 0o600 });
}

function readJson<T>(filepath: string): T | null {
  if (!fs.existsSync(filepath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filepath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class AgentShieldApprovalStore {
  private baseDir: string;
  private requestsDir: string;
  private decisionsDir: string;

  constructor(stateDir?: string) {
    const resolvedStateDir = stateDir ?? resolveStateDir();
    this.baseDir = path.join(resolvedStateDir, "agentshield", "approvals");
    this.requestsDir = path.join(this.baseDir, "requests");
    this.decisionsDir = path.join(this.baseDir, "decisions");
  }

  /**
   * Store an approval request (safe metadata only).
   */
  storeRequest(record: ApprovalRequestRecord): void {
    const filepath = path.join(this.requestsDir, `${record.id}.json`);
    writeJsonSecure(filepath, record);
  }

  /**
   * Load an approval request by ID.
   */
  loadRequest(id: string): ApprovalRequestRecord | null {
    const filepath = path.join(this.requestsDir, `${id}.json`);
    return readJson<ApprovalRequestRecord>(filepath);
  }

  /**
   * Update the status of an approval request.
   */
  updateRequestStatus(id: string, status: ApprovalRequestStatus): boolean {
    const record = this.loadRequest(id);
    if (!record) {
      return false;
    }
    record.status = status;
    this.storeRequest(record);
    return true;
  }

  /**
   * Store an approval decision.
   */
  storeDecision(record: ApprovalDecisionRecord): void {
    const filepath = path.join(this.decisionsDir, `${record.id}.json`);
    writeJsonSecure(filepath, record);
    // Update the request status
    const newStatus: ApprovalRequestStatus =
      record.decision === "deny" ? "denied" : "approved";
    this.updateRequestStatus(record.id, newStatus);
  }

  /**
   * Load an approval decision by ID.
   */
  loadDecision(id: string): ApprovalDecisionRecord | null {
    const filepath = path.join(this.decisionsDir, `${id}.json`);
    return readJson<ApprovalDecisionRecord>(filepath);
  }

  /**
   * List all approval requests, optionally filtered by status.
   */
  listRequests(opts?: {
    status?: ApprovalRequestStatus;
    limit?: number;
  }): ApprovalRequestRecord[] {
    ensureDir(this.requestsDir);
    const files = fs.readdirSync(this.requestsDir).filter((f) => f.endsWith(".json"));
    const records: ApprovalRequestRecord[] = [];

    for (const file of files) {
      const record = readJson<ApprovalRequestRecord>(path.join(this.requestsDir, file));
      if (!record) continue;

      // Check for expired pending requests
      if (record.status === "pending" && new Date(record.expiresAt) < new Date()) {
        record.status = "expired";
        this.storeRequest(record);
      }

      if (opts?.status && record.status !== opts.status) {
        continue;
      }
      records.push(record);
    }

    // Sort by createdAt descending (newest first)
    records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (opts?.limit && opts.limit > 0) {
      return records.slice(0, opts.limit);
    }
    return records;
  }

  /**
   * Remove an approval request and its decision.
   */
  remove(id: string): boolean {
    const requestPath = path.join(this.requestsDir, `${id}.json`);
    const decisionPath = path.join(this.decisionsDir, `${id}.json`);
    let removed = false;
    if (fs.existsSync(requestPath)) {
      fs.unlinkSync(requestPath);
      removed = true;
    }
    if (fs.existsSync(decisionPath)) {
      fs.unlinkSync(decisionPath);
      removed = true;
    }
    return removed;
  }

  /**
   * Clean up expired requests older than the given age in milliseconds.
   */
  cleanupExpired(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const requests = this.listRequests({ status: "expired" });
    let removed = 0;
    for (const req of requests) {
      const createdAt = new Date(req.createdAt).getTime();
      if (createdAt < cutoff) {
        this.remove(req.id);
        removed++;
      }
    }
    return removed;
  }
}
