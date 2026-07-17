// Doctor-only import for retired core JSONL audit stores.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_AUDIT_MAX_ENTRIES,
  CONFIG_AUDIT_SCOPE,
  sanitizeConfigAuditRecord,
  type ConfigAuditRecord,
} from "../config/io.audit.js";
import { redactSecrets } from "../logging/redact.js";
import {
  SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
  SYSTEM_AGENT_AUDIT_SCOPE,
  type SystemAgentAuditEntry,
} from "../system-agent/audit.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import type {
  LegacyAuditLogSource,
  LegacyAuditLogsDetection,
} from "./state-migrations.audit-logs.types.js";
import { archiveLegacyImportSource } from "./state-migrations.storage.js";
import type { MigrationMessages } from "./state-migrations.types.js";

type PreparedAuditRecord = {
  key: string;
  value: ConfigAuditRecord | SystemAgentAuditEntry;
  createdAt: number;
};

function legacyAuditRecordCreatedAt(
  source: LegacyAuditLogSource,
  value: ConfigAuditRecord | SystemAgentAuditEntry,
): number {
  const timestamp =
    source.kind === "config"
      ? (value as Partial<ConfigAuditRecord>).ts
      : (value as Partial<SystemAgentAuditEntry>).timestamp;
  if (typeof timestamp !== "string") {
    return 0;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function detectLegacyAuditLogs(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyAuditLogsDetection {
  const candidates: LegacyAuditLogSource[] = [
    {
      kind: "config",
      label: "config audit log",
      sourcePath: path.join(params.stateDir, "logs", "config-audit.jsonl"),
    },
    {
      kind: "system-agent",
      label: "system-agent audit log",
      sourcePath: path.join(params.stateDir, "audit", "system-agent.jsonl"),
    },
    {
      kind: "crestodian",
      label: "Crestodian audit log",
      sourcePath: path.join(params.stateDir, "audit", "crestodian.jsonl"),
    },
  ];
  // Intentionally invisible to automatic startup migration. That caller migrates every
  // detected source; these audit imports belong only to explicit `doctor --fix` repair.
  const sources =
    params.doctorOnlyStateMigrations === true
      ? candidates.filter((source) => fs.existsSync(source.sourcePath))
      : [];
  return { sources, hasLegacy: sources.length > 0 };
}

type PreparedLegacyAuditRecords =
  | { ok: false; warnings: string[] }
  | {
      ok: true;
      records: PreparedAuditRecord[];
      sourceRaw: string;
      sanitizedJsonl: string;
    };

function prepareLegacyAuditRecords(source: LegacyAuditLogSource): PreparedLegacyAuditRecords {
  const records: PreparedAuditRecord[] = [];
  const warnings: string[] = [];
  const raw = fs.readFileSync(source.sourcePath, "utf8");
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      warnings.push(
        `Failed reading ${source.label} record at ${source.sourcePath}:${index + 1}: ${String(error)}`,
      );
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(
        `Skipped non-object ${source.label} record at ${source.sourcePath}:${index + 1}`,
      );
      continue;
    }
    const value =
      source.kind === "config"
        ? sanitizeConfigAuditRecord(parsed as ConfigAuditRecord)
        : (redactSecrets(parsed) as SystemAgentAuditEntry);
    const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
    records.push({
      key: `legacy:${source.kind}:${index + 1}:${digest}`,
      value,
      createdAt: legacyAuditRecordCreatedAt(source, value),
    });
  }
  if (warnings.length > 0) {
    return { ok: false, warnings };
  }
  return {
    ok: true,
    records,
    sourceRaw: raw,
    sanitizedJsonl:
      records.length > 0
        ? `${records.map((record) => JSON.stringify(record.value)).join("\n")}\n`
        : "",
  };
}

function replaceLegacyAuditSourceWithSanitizedContent(params: {
  source: LegacyAuditLogSource;
  sourceRaw: string;
  sanitizedJsonl: string;
  warnings: string[];
}): boolean {
  const tempPath = path.join(
    path.dirname(params.source.sourcePath),
    `.${path.basename(params.source.sourcePath)}.sanitize-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    if (fs.readFileSync(params.source.sourcePath, "utf8") !== params.sourceRaw) {
      params.warnings.push(
        `Skipped archiving ${params.source.label} because the legacy source changed after import`,
      );
      return false;
    }
    fs.writeFileSync(tempPath, params.sanitizedJsonl, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (fs.readFileSync(params.source.sourcePath, "utf8") !== params.sourceRaw) {
      params.warnings.push(
        `Skipped archiving ${params.source.label} because the legacy source changed during sanitization`,
      );
      return false;
    }
    fs.renameSync(tempPath, params.source.sourcePath);
    return true;
  } catch (error) {
    params.warnings.push(
      `Failed sanitizing ${params.source.label} legacy source before archival: ${String(error)}`,
    );
    return false;
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function migrateLegacyAuditLogSource(params: {
  source: LegacyAuditLogSource;
  stateDir: string;
}): MigrationMessages {
  const changes: string[] = [];
  const prepared = prepareLegacyAuditRecords(params.source);
  if (!prepared.ok) {
    return { changes, warnings: prepared.warnings };
  }
  const warnings: string[] = [];
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const maxEntries =
    params.source.kind === "config" ? CONFIG_AUDIT_MAX_ENTRIES : SYSTEM_AGENT_AUDIT_MAX_ENTRIES;
  const store = createSqliteAuditRecordStore<ConfigAuditRecord | SystemAgentAuditEntry>({
    scope: params.source.kind === "config" ? CONFIG_AUDIT_SCOPE : SYSTEM_AGENT_AUDIT_SCOPE,
    maxEntries,
    env,
  });
  const existingKeys = new Set(store.entries().map((entry) => entry.key));
  const missing = prepared.records.filter((record) => !existingKeys.has(record.key));
  if (missing.length > maxEntries - store.size()) {
    warnings.push(
      `Skipped ${params.source.label} migration because SQLite has room for ${maxEntries - store.size()} of ${missing.length} missing rows; left legacy source in place`,
    );
    return { changes, warnings };
  }
  for (const record of missing) {
    store.register(record.key, record.value, record.createdAt);
  }
  const importedKeys = new Set(store.entries().map((entry) => entry.key));
  const missingKey = prepared.records.find((record) => !importedKeys.has(record.key))?.key;
  if (missingKey) {
    warnings.push(`SQLite verification missed ${params.source.label} row ${missingKey}`);
    return { changes, warnings };
  }
  if (
    !replaceLegacyAuditSourceWithSanitizedContent({
      source: params.source,
      sourceRaw: prepared.sourceRaw,
      sanitizedJsonl: prepared.sanitizedJsonl,
      warnings,
    })
  ) {
    return { changes, warnings };
  }
  changes.push(
    `Migrated ${params.source.label} -> shared SQLite state (${missing.length} new row(s))`,
  );
  archiveLegacyImportSource({
    sourcePath: params.source.sourcePath,
    label: params.source.label,
    changes,
    warnings,
  });
  return { changes, warnings };
}

export async function migrateLegacyAuditLogs(params: {
  detected: LegacyAuditLogsDetection;
  stateDir: string;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (params.detected.sources.length === 0) {
    return { changes, warnings };
  }
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    // Retired audit paths have no current writer. Exclusive state ownership also
    // excludes a running predecessor Gateway and sibling doctor during raw-file removal.
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 25,
      role: "sqlite-maintenance",
      timeoutMs: 250,
    });
  } catch (error) {
    warnings.push(
      `Skipped legacy audit migration because exclusive state ownership is unavailable: ${String(error)}`,
    );
    return { changes, warnings };
  }
  if (!lock) {
    warnings.push(
      "Skipped legacy audit migration because exclusive state ownership is unavailable",
    );
    return { changes, warnings };
  }
  try {
    for (const source of params.detected.sources) {
      try {
        const result = migrateLegacyAuditLogSource({ source, stateDir: params.stateDir });
        changes.push(...result.changes);
        warnings.push(...result.warnings);
      } catch (error) {
        warnings.push(`Failed migrating ${source.label}: ${String(error)}`);
      }
    }
  } finally {
    await lock.release();
  }
  return { changes, warnings };
}
