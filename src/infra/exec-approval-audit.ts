import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const APPROVAL_AUDIT_LOG_FILENAME = "approvals.jsonl";

// Keys whose values should be redacted when logging args.
const SECRET_KEY_PATTERNS = /key|token|password|secret|credential|auth|apikey/i;

export type ApprovalAuditResolvedBy = {
  deviceId?: string | null;
  clientId?: string | null;
  connId?: string | null;
};

export type ApprovalAuditEntry = {
  ts: number;
  approvalId: string;
  command: string;
  decision: "approved" | "denied";
  resolvedBy: ApprovalAuditResolvedBy;
  agentId?: string | null;
  sessionKey?: string | null;
  args?: unknown;
};

export function resolveApprovalAuditLogPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => os.homedir(),
): string {
  return path.join(resolveStateDir(env, homedir), "audit", APPROVAL_AUDIT_LOG_FILENAME);
}

function redactSecretArgs(args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    result[key] = SECRET_KEY_PATTERNS.test(key) ? "[REDACTED]" : value;
  }
  return result;
}

export function appendApprovalAuditEntry(
  entry: ApprovalAuditEntry,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => os.homedir(),
): void {
  try {
    const auditPath = resolveApprovalAuditLogPath(env, homedir);
    const redacted: ApprovalAuditEntry = {
      ...entry,
      args: entry.args !== undefined ? redactSecretArgs(entry.args) : undefined,
    };
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(auditPath, `${JSON.stringify(redacted)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}

export type ReadApprovalAuditLogOpts = {
  since?: number;
  limit?: number;
  agentId?: string;
};

export function readApprovalAuditLog(
  opts: ReadApprovalAuditLogOpts = {},
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => os.homedir(),
): ApprovalAuditEntry[] {
  const auditPath = resolveApprovalAuditLogPath(env, homedir);
  let raw: string;
  try {
    raw = fs.readFileSync(auditPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const entries: ApprovalAuditEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ApprovalAuditEntry;
      if (opts.since !== undefined && entry.ts < opts.since) {
        continue;
      }
      if (opts.agentId !== undefined && entry.agentId !== opts.agentId) {
        continue;
      }
      entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }

  if (opts.limit !== undefined && opts.limit > 0 && entries.length > opts.limit) {
    return entries.slice(entries.length - opts.limit);
  }
  return entries;
}
