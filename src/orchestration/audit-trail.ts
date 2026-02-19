import fs from "node:fs";
import path from "node:path";

export type OrchestrationAuditEvent = {
  ts: string;
  type:
    | "plugin.discovered"
    | "plugin.enable"
    | "plugin.disable"
    | "plugin.compatibility_failed"
    | "policy.blocked"
    | "orchestration.job_enqueued"
    | "orchestration.job_started"
    | "orchestration.job_completed"
    | "orchestration.job_failed"
    | "orchestration.job_skipped_idempotent";
  actor?: string;
  pluginId?: string;
  jobId?: string;
  action?: string;
  reason?: string;
  meta?: Record<string, unknown>;
};

function ensureParent(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function appendAuditEvent(filePath: string, event: Omit<OrchestrationAuditEvent, "ts">) {
  ensureParent(filePath);
  const full: OrchestrationAuditEvent = {
    ts: new Date().toISOString(),
    ...event,
  };
  fs.appendFileSync(filePath, `${JSON.stringify(full)}\n`, "utf-8");
}
