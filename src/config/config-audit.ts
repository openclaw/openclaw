import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "./paths.js";

const CONFIG_SECURITY_AUDIT_FILENAME = "config-audit.jsonl";

export type ConfigSecurityAuditActor = "gateway" | "filesystem";

export type ConfigSecurityAuditEntry = {
  timestamp: string;
  actor: ConfigSecurityAuditActor;
  changedPaths: string[];
  sourceHash: string | null;
  resultHash: string | null;
};

function resolveConfigSecurityAuditLogPath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  return path.join(resolveStateDir(env, homedir), "logs", CONFIG_SECURITY_AUDIT_FILENAME);
}

/**
 * Appends a config security audit record to the audit log.
 * Best-effort; failures are silently ignored.
 */
export async function appendConfigSecurityAuditEntry(params: {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  actor: ConfigSecurityAuditActor;
  changedPaths: string[];
  sourceHash: string | null;
  resultHash: string | null;
}): Promise<void> {
  try {
    const auditPath = resolveConfigSecurityAuditLogPath(params.env, params.homedir);
    const entry: ConfigSecurityAuditEntry = {
      timestamp: new Date().toISOString(),
      actor: params.actor,
      changedPaths: params.changedPaths,
      sourceHash: params.sourceHash,
      resultHash: params.resultHash,
    };
    await fs.promises.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    await fs.promises.appendFile(auditPath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}

/**
 * Synchronous variant for use in sync config load paths.
 * Best-effort; failures are silently ignored.
 */
export function appendConfigSecurityAuditEntrySync(params: {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  actor: ConfigSecurityAuditActor;
  changedPaths: string[];
  sourceHash: string | null;
  resultHash: string | null;
}): void {
  try {
    const auditPath = resolveConfigSecurityAuditLogPath(params.env, params.homedir);
    const entry: ConfigSecurityAuditEntry = {
      timestamp: new Date().toISOString(),
      actor: params.actor,
      changedPaths: params.changedPaths,
      sourceHash: params.sourceHash,
      resultHash: params.resultHash,
    };
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}
