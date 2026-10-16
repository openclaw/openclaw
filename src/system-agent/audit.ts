// OpenClaw audit helpers persist approved local-state changes.
import { randomUUID } from "node:crypto";
import { registerSqliteAuditRecordAsync } from "../infra/sqlite-audit-record-store.async.js";
import { redactSecrets } from "../logging/redact.js";

/**
 * Append-only audit log helpers for OpenClaw writes.
 *
 * Discovery and read-only commands stay quiet; persistent operations append a
 * SQLite entry under the shared state directory with config hashes and redacted details.
 */
export type SystemAgentAuditEntry = {
  timestamp: string;
  operation: string;
  summary: string;
  configPath?: string;
  configHashBefore?: string | null;
  configHashAfter?: string | null;
  details?: Record<string, unknown>;
};

export const SYSTEM_AGENT_AUDIT_SCOPE = "system-agent-audit";
export const SYSTEM_AGENT_AUDIT_MAX_ENTRIES = 50_000;
export const SYSTEM_AGENT_AUDIT_STORE_LABEL =
  "SQLite diagnostic_events/system-agent-audit state (latest 50000 rows)";

/** Append one OpenClaw audit entry and return its SQLite owner label. */
export async function appendSystemAgentAuditEntry(
  entry: Omit<SystemAgentAuditEntry, "timestamp">,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const record = redactSecrets({
    timestamp: new Date().toISOString(),
    ...entry,
  } satisfies SystemAgentAuditEntry);
  await registerSqliteAuditRecordAsync(
    {
      scope: SYSTEM_AGENT_AUDIT_SCOPE,
      maxEntries: SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
      env: opts.env,
    },
    {
      key: `${record.timestamp}:${randomUUID()}`,
      value: record,
      createdAt: Date.parse(record.timestamp),
    },
  );
  return SYSTEM_AGENT_AUDIT_STORE_LABEL;
}
